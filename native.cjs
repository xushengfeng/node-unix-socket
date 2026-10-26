const { existsSync } = require("node:fs");
const { join } = require("node:path");

const prebuilt = join(__dirname, "prebuilds", `${process.platform}-${process.arch}`, "index.node");
const legacy = join(__dirname, "index.node");

if (!existsSync(prebuilt) && !existsSync(legacy)) {
    throw new Error(
        `myde-unix-socket: 没有 ${process.platform}-${process.arch} 的原生模块，请先运行 npm run build:rust`,
    );
}

module.exports = require(existsSync(prebuilt) ? prebuilt : legacy);
