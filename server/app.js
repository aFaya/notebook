// const { exec } = require('child_process');
const hogan = require('hogan');
const Koa = require('koa');
const router = require('koa-router')();
const body = require('koa-body');
const fs = require('fs');
const path = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const minify = require('html-minifier').minify;

const app = new Koa();

const getRes = async () => {
    const notebookJson = await readFile(path.join(__dirname, 'notebook.json'), 'utf8');
    const testJson = await writeFile(path.join(__dirname, 'test.json'), notebookJson, 'utf8');
    // const { stdout, stderr } = await exec(`jupyter nbconvert --to html --template basic ${notebookJson}`);
    await exec(`jupyter nbconvert --to html --template basic test.json`);
    const res = await readFile(path.join(__dirname, 'notebook.html'), 'utf8');
    return minify(res, { removeAttributeQuotes: true });
}

// app.use(async ctx => {
router.get('/', body(), async ctx => {
    const res = await getRes();
    // console.log(res);
    console.log('haha');
    ctx.body = res;
});

app
    .use(router.routes())
    .listen(3000);

