import * as core from '@actions/core';
import {promises as fs} from 'fs';
import {existsSync, createWriteStream} from 'fs';
import https from 'https';
import path from 'path';
import util from 'util';
import {exec} from 'child_process';
import {env} from 'process';

const asyncExec = util.promisify(exec);
const certificatePfxFilepath = env['TEMP'] + '\\certificate.pfx';
const nugetFileName = env['TEMP'] + '\\nuget.exe';

const timestampUrl = 'http://timestamp.digicert.com';
const signtool = 'C:/Program Files (x86)/Windows Kits/10/bin/10.0.17763.0/x86/signtool.exe';

const signtoolFileExtensions = [
    '.dll', '.exe', '.sys', '.vxd',
    '.msix', '.msixbundle', '.appx',
    '.appxbundle', '.msi', '.msp',
    '.msm', '.cab', '.ps1', '.psm1'
];

function sleep(seconds: number) {
    if (seconds > 0)
        console.log(`Waiting for ${seconds} seconds.`);
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

async function createCertificatePfx() {
    const base64Certificate = core.getInput('certificate');
    const certificate = Buffer.from(base64Certificate, 'base64');
    if (certificate.length==0) {
        console.log('The value for "certificate" is not set.');
        return false;
    }
    console.log(`Writing ${certificate.length} bytes to ${certificatePfxFilepath}.`);
    await fs.writeFile(certificatePfxFilepath, certificate);

    // const importCert = core.getInput("import_certificate");
    // if (importCert == 'true') {
    //     //CERTUTIL -f -p somePassword -importpfx "somePfx.pfx"
    //     let pwd = core.getInput('password');
    //     pwd = pwd ? `-p ${pwd}` : '';
    //     await asyncExec(`CERTUTIL -f ${pwd} -importpfx "${certificatePfxFilepath}" My`)
    // }

    return true;
}

async function downloadNuGet() {
    return new Promise(resolve => {
        if (existsSync(nugetFileName)) {
            resolve();
            return;
        }

        console.log(`Downloading nuget.exe.`);

        const file = createWriteStream(nugetFileName);
        https.get('https://dist.nuget.org/win-x86-commandline/latest/nuget.exe', (response) => {
            response.pipe(file);
            file.on('finish', function () {
                file.close();
                resolve();
            });
        });
    });
}

function setOutputSignCmd() {
    let sign_args = core.getInput('sign_args');
    let cmd = `"${signtool}" `
        .concat(`sign /f ${certificatePfxFilepath} `)
        .concat(`/tr ${timestampUrl} `)
        .concat(`/v `)
        .concat(`/fd sha256 `);

    if (sign_args) {
        core.debug(`override default sign args`);
        sign_args = `sign /f ${certificatePfxFilepath} ${sign_args} `;
        cmd = `"${signtool}" sign /f ${certificatePfxFilepath} ${sign_args} `;
    }

    core.setOutput("signtool_cmd", cmd);
    core.setOutput("certificate_pfx_filepath", certificatePfxFilepath);
    core.setOutput("sign_args", sign_args);
    return cmd;
}

async function signWithSigntool(fileName: string) {
    try {
        const cmd = setOutputSignCmd() + ` ${fileName}`;
        const {stdout} = await asyncExec(cmd.toString());
        console.log(stdout);
        return true;
    }
    catch (err) {
        console.log(err.stdout);
        console.log(err.stderr);
        return false;
    }
}

//TODO add support to set sign NUGET later
async function signNupkg(fileName: string) {
    await downloadNuGet();

    try {
        const {stdout} = await asyncExec(`"${nugetFileName}" sign ${fileName} -CertificatePath ${certificatePfxFilepath} -Timestamper ${timestampUrl}`);
        console.log(stdout);
        return true;
    }
    catch (err) {
        console.log(err.stdout);
        console.log(err.stderr);
        return false;
    }
}

async function trySignFile(fileName: string) {
    console.log(`Signing ${fileName}.`);
    const extension = path.extname(fileName);
    for (let i = 0; i < 10; i++) {
        await sleep(i);
        if (signtoolFileExtensions.includes(extension)) {
            if (await signWithSigntool(fileName))
                return;
        } else if (extension=='.nupkg') {
            if (await signNupkg(fileName))
                return;
        }
    }
    throw `Failed to sign '${fileName}'.`;
}

async function* getFiles(folder: string, recursive: boolean): any {
    const files = await fs.readdir(folder);
    for (const file of files) {
        const fullPath = `${folder}/${file}`;
        const stat = await fs.stat(fullPath);
        if (stat.isFile()) {
            const extension = path.extname(file);
            if (signtoolFileExtensions.includes(extension) || extension=='.nupkg')
                yield fullPath;
        } else if (stat.isDirectory() && recursive) {
            yield* getFiles(fullPath, recursive);
        }
    }
}

async function signFiles() {
    const folder = core.getInput('folder');
    if (folder) {
        const recursive = core.getInput('recursive')=='true';
        for await (const file of getFiles(folder, recursive)) {
            await trySignFile(file);
        }
    }
    else {
        setOutputSignCmd();
    }
}

async function run() {
    try {
        if (await createCertificatePfx())
            await signFiles();
    }
    catch (err) {
        core.setFailed(`Action failed with error: ${err}`);
    }
}

run();
