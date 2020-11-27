const path = require('path');
const execa = require('execa');
const pfs = require('promise-fs');
const _ = require('underscore');
const logger = require("./logger");
const util = global.requireUtil();
const pathUtil = require("./pathUtil");
const { isImage, getCurrentTime, isGif } = util;

const sevenZipHelp = require("./sevenZipHelp");
const { listZipContentAndUpdateDb, extractAll }= sevenZipHelp;

const { isExist, getRootPath, getImgConverterCachePath } = pathUtil;

const userConfig = global.requireUserConfig();
const filesizeUitl = require('filesize');

const rimraf = require("../tools/rimraf");

const serverUtil = require("./serverUtil");
const getStat = serverUtil.common.getStat;

let { img_convert_quality, img_convert_dest_type, 
        img_convert_huge_threshold, img_reduce_resolution_dimension,
        img_convert_min_threshold, img_convert_quality_for_middle_size_file } = userConfig;

img_convert_huge_threshold *= 1024*1024;
img_convert_min_threshold *= 1024*1024;



function logFail(filePath, e){
    logger.error("[imageMagickHelp]]", filePath, e);
}

global._has_magick_ = true;
execa("magick")
.then(() => {})
.catch(e => {
    global._has_magick_ = false;
    console.log("Did not install magick")
});



//https://imagemagick.org/script/download.php#windows

async function convertImage(imgFilePath, outputImgPath, oldImgSize){
    try{
        let opt;
        if(oldImgSize > img_convert_huge_threshold){
            opt = [imgFilePath, "-strip", "-quality", img_convert_quality, "-resize", `${img_reduce_resolution_dimension}\>`, outputImgPath ];
        }else{
            opt = [imgFilePath, "-strip", "-quality", img_convert_quality_for_middle_size_file, outputImgPath ];
        }

        let {stdout, stderr} = await execa("magick", opt);
        return {stdout, stderr};
    }catch(e){
        logFail("[convertImage]", e);
    }
}

module.exports.isConertable = async function(filePath){
    if(!global._has_magick_){
        return "No magick";
    }

    let text = "no_problem";
    return text;
}

//ONLY KEEP THE CORRECT FILES IN FOLDER AFTER EVERYTHING
module.exports.minifyOneFile = async function(filePath){
    let extractOutputPath;
    let minifyOutputPath;
    try{
        const oldStat = await getStat(filePath);
        const oldTemp = await listZipContentAndUpdateDb(filePath);
        const oldFiles = oldTemp.files;

        //one folder for extract
        //one for minify image
        const bookName = path.basename(filePath, path.extname(filePath));
        const subfoldername = `from ${path.basename(path.dirname(filePath))}`
        const convertSpace = path.join(getImgConverterCachePath(), subfoldername);
        extractOutputPath = path.join(convertSpace, bookName+"-original");
        minifyOutputPath = path.join(convertSpace, bookName);

        //mkdir for output
        if(!(await isExist(minifyOutputPath))){
            const mdkirErr = await pfs.mkdir(minifyOutputPath, { recursive: true});
            if(mdkirErr){
                logFail(filePath, "cannot create output folder");
                return;
            }
        }

        //do a brand new extract 
        const { pathes, error } = await extractAll(filePath, extractOutputPath);
        if (error) {
            logFail(filePath, "failed to extractAll", error);
            return;
        } 
        

        if (!isExtractAllSameWithOriginalFiles(pathes, oldFiles)){
            logFail(filePath,"ExtractAll Different than Original Files");
            return;
        }
        console.log("-----begin images convertion --------------");
        console.log(filePath);
        const _pathes = pathes;
        const total = _pathes.length;
        let converterError;
        const beginTime = getCurrentTime();

        //convert one by one
        for(let ii = 0; ii < total; ii++){
            const fname = _pathes[ii];
            const fp = path.resolve(extractOutputPath, fname);
            try{
                const stat = await pfs.stat(fp);
                const oldSize = stat.size;
                let simplyCopy = !isImage(fname) || isGif(fname);
                simplyCopy = simplyCopy || (isImage(fname)  && oldSize < img_convert_min_threshold)

                if(simplyCopy){
                    const outputImgPath = path.resolve(minifyOutputPath, fname);
                    //this copy file does not create folder and isnot recursive
                    await pfs.copyFile(fp, outputImgPath);
                }else{
                    //use imageMagik to convert 
                    //  magick 1.jpeg   50 1.webp
                    const name = path.basename(fname, path.extname(fname)) + img_convert_dest_type;
                    const outputImgPath = path.resolve(minifyOutputPath, name);
                    let {stdout, stderr} = await convertImage(fp, outputImgPath, oldSize);
                    if (stderr) {
                        throw stderr;
                    }
                    
                    const timeSpent = getCurrentTime() - beginTime;
                    const timePerImg = timeSpent/(ii+1)/1000; // in second
                    const remaintime = (total - ii) * timePerImg;
                    if(ii+1 < total){
                        console.log(`${ii+1}/${total}      ${(timePerImg).toFixed(2)} second per file   ${remaintime.toFixed(2)} second before finish`);
                    } else {
                        console.log(`${ii+1}/${total}`);
                        // console.log("finish convertion. going to check if there is any error")
                    }
                }

            }catch(err){
                converterError = err;
                break;
            }
        }

        if(converterError){
            logFail(filePath, converterError);
            return;
        }

        //zip into a new zip file
        //todo: The process cannot access the file because it is being used by another process
        let {stdout, stderr, resultZipPath} = await sevenZipHelp.zipOneFolder(minifyOutputPath);
        if(stderr){
            logFail(filePath, "sevenZipHelp.zipOneFolder fail");
            deleteCache(resultZipPath);
            return;
        }

        const temp = await listZipContentAndUpdateDb(resultZipPath);
        const filesInNewZip = temp.files;
        if(!isNewZipSameWithOriginalFiles(filesInNewZip, oldFiles)){
            logFail(filePath, "filesInNewZip is missing files");
            deleteCache(resultZipPath);
            return;
        }
        const newStat = await getStat(resultZipPath);
 
        const reducePercentage = (100 - newStat.size/oldStat.size * 100).toFixed(2);

        const userful_percent = 20;

        if(reducePercentage < userful_percent){
            console.log(`size reduce ${reducePercentage}%`);
            logFail(filePath, "not a useful work. abandon");
            deleteCache(resultZipPath);
        }else{
            //manually let file have the same modify time
            const error  = await pfs.utimes(resultZipPath, oldStat.atime , oldStat.mtime);
            if(error){
                logFail(filePath, "pfs.utimes failed");
                deleteCache(resultZipPath);
            } else {
                logger.info("convertion done", filePath);
                console.log("original size",filesizeUitl(oldStat.size, {base: 2}));
                console.log("new size", filesizeUitl(newStat.size, {base: 2}));
                console.log(`size reduce ${reducePercentage}%`);
                console.log("output file is at", convertSpace);

                return {
                    oldSize: oldStat.size,
                    newSize: newStat.size,
                    saveSpace: (oldStat.size - newStat.size)
                }
            }
        }
    } catch(e) {
        logFail(filePath, e);
    } finally {
        //maybe let user to delete file manually?
        deleteCache(extractOutputPath);
        deleteCache(minifyOutputPath);
        console.log("------------------------------");
    }
}

function deleteCache(filePath){
    if(filePath){
        rimraf(filePath, (err) =>{ 
            if(err){
                console.error("[clean imageMagickHelp]", filePath, err);
            }
        });
    }
}

function isExtractAllSameWithOriginalFiles(newFiles, files){
    if(!newFiles){
        return false;
    }

    const expect_file_names = files.filter(isImage).map(e => path.basename(e)).sort();
    const resulted_file_names =  newFiles.filter(isImage).map(e => path.basename(e)).sort();
    return _.isEqual(resulted_file_names, expect_file_names);
}

function getFn(e){
    return path.basename(e, path.extname(e));
}

const isNewZipSameWithOriginalFiles = module.exports.isNewZipSameWithOriginalFiles = function (newFiles, files){
    if(!newFiles){
        return false;
    }

    const expect_file_names = files.filter(isImage).map(getFn).sort();
    const resulted_file_names =  newFiles.filter(isImage).map(getFn).sort();
    return _.isEqual(resulted_file_names, expect_file_names)
}