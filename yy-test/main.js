import { Worker } from "worker_threads";
import { config } from "./utils.mjs";
import { Connection } from "@solana/web3.js";
import fs from 'fs';

const NUM_WORKERS = config.THREAD_COUNT; // 自定义 Worker 数量

// 读取 middle_mints 文件
let middleMints;
try {
    const mintsData = fs.readFileSync(config.MIDDLE_MINTS, 'utf8');
    middleMints = JSON.parse(mintsData);
} catch (error) {
    console.error('读取 middle_mints 文件失败:', error);
    process.exit(1);
}

// 定义全局常量
const globalConstants = {
    RPC_URL: config.RPC_URL,
    PRIVATE_KEY: config.KEYPAIR,
    BASE_MINT: config.WSOL,
    AMOUNT_IN_MIN: config.AMOUNT_IN_MIN,
    AMOUNT_IN_MAX: config.AMOUNT_IN_MAX,
    JITO_TIP_ACCOUNTS: config.JITO_TIP_ACCOUNTS,
    MIDDLE_MINTS: middleMints,  // 传递读取到的数组
    JITO_URLS: config.JITO_URLS,
    JITO_STATIC_TIP: config.JITO_STATIC_TIP,
    PROXY_ACCOUNTS: config.PROXY_ACCOUNTS,
    SERVER_IPS: config.SERVER_IPS
};

// 创建指定数量的 Worker
for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = new Worker("./worker.js");
    
    // 发送初始化消息，包含线程ID
    worker.postMessage({ 
        type: 'init', 
        constants: { ...globalConstants, workerId: i } 
    });

    // 监听 Worker 消息
    worker.on("message", (result) => {
        //console.log(`Worker ${i} 完成任务:`, result);
    });

    // 监听 Worker 错误
    worker.on("error", (error) => {
        console.error(`Worker ${i} 发生错误:`, error);
    });

    // 监听 Worker 退出
    worker.on("exit", (code) => {
        if (code !== 0) {
            console.error(`Worker ${i} 退出，退出码: ${code}`);
        }
    });
}
