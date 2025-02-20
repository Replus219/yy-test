import fs from "fs";
import toml from "toml";

// 读取并解析 TOML 配置文件
function loadConfig(filePath) {
    const data = fs.readFileSync(filePath, "utf8");
    return toml.parse(data);
}

// 导出加载的配置
export const config = loadConfig("./config.toml");
