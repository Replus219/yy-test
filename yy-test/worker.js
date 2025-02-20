import { parentPort } from "worker_threads";
import {
    Connection,
    Keypair,
    VersionedTransaction,
    TransactionMessage,
    TransactionInstruction,
    PublicKey
} from "@solana/web3.js";
import { Wallet } from "@project-serum/anchor";
import bs58 from "bs58";
import fs from 'fs';
import {
    find_opportunity,
    combineTwoQuoteResponses,
    getInstruction,
    getAddressLookupTableAccounts,
    createArbSwapInstruction,
    createTransferTipInstruction,
    sendTransactionToJito,
    updateBlockhash,
    createSetupInstructions,
    setComputeUnitLimit
} from "./utils.mjs";

// 声明变量，等待初始化
let connection;
let sign_wallet;
let payer;
let baseMint;
let amountInMin;
let amountInMax;
let jito_tip_accounts;
let middle_mints;
let jito_urls;
let jito_static_tip;
let proxy_accounts;
let server_ips;
let workerId;

// 生成随机金额
function getRandomAmount() {
    return Math.floor(Math.random() * (amountInMax - amountInMin + 1)) + amountInMin;
}

// 自定义日志函数
function log(...args) {
    console.log(`[Worker-${workerId}]`, ...args);
}

function logError(...args) {
    console.error(`[Worker-${workerId}]`, ...args);
}

// 初始化全局变量
global.currentBlockhash = null;

async function initializeWorker(constants) {
    workerId = constants.workerId;
    connection = new Connection(constants.RPC_URL);
    const PRIVATE_KEY = constants.PRIVATE_KEY;
    sign_wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY)));
    payer = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    baseMint = constants.BASE_MINT;
    amountInMin = constants.AMOUNT_IN_MIN;
    amountInMax = constants.AMOUNT_IN_MAX;
    jito_tip_accounts = constants.JITO_TIP_ACCOUNTS;
    middle_mints = constants.MIDDLE_MINTS;
    jito_urls = constants.JITO_URLS;
    jito_static_tip = constants.JITO_STATIC_TIP;
    proxy_accounts = constants.PROXY_ACCOUNTS;
    server_ips = constants.SERVER_IPS;

    // 启动后台更新 blockhash
    updateBlockhash(connection);
    setInterval(() => updateBlockhash(connection), 500);
}

async function arbtriage() {
    while (true) {
        try {
            // 检查 blockhash 是否已经初始化
            if (!global.currentBlockhash) {
                log("等待 blockhash 初始化...");
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
            }

            // 生成随机金额
            const initialAmountIn = getRandomAmount();

            // 选择Jito小费账户
            const randomTipAccount =
                jito_tip_accounts[
                    Math.floor(Math.random() * jito_tip_accounts.length)
                ];

            // 选择随机代理钱包
            const proxyPrivateKey = proxy_accounts[Math.floor(Math.random() * proxy_accounts.length)];
            const proxyWalletAccount = Keypair.fromSecretKey(bs58.decode(proxyPrivateKey));
            const proxy_sign_wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(proxyPrivateKey)));
                
            // 选择随机MintToken
            const middleMint =
                middle_mints[Math.floor(Math.random() * middle_mints.length)];

            // 获取QuoteResponse
            const opportunity = await find_opportunity(
                baseMint,
                middleMint,
                initialAmountIn,
                0
            );

            if (opportunity == null) {
                continue;
            }

            const { firstRouter, secondRouter, estimateProfitMinusTip,jitoTip } =
                opportunity;

            //log("当前blockhash", global.currentBlockhash);

            // 组合两个QuoteResponse
            const combinedQuoteResponse = combineTwoQuoteResponses(
                firstRouter,
                secondRouter,
                0
            );
            // 获取Swap指令和地址查找表
            const { swapInstructionPayLoad, setupInstructionPayLoad,addressLookupTableAddresses } =
                await getInstruction(combinedQuoteResponse, sign_wallet);
            //log("Swap指令获取成功!");

            // 获取并转换地址查找表
            const addressLookupTableAccounts =
                await getAddressLookupTableAccounts(
                    addressLookupTableAddresses,
                    connection
                );
            //log("地址查找表获取成功！");

            // 构建Swap指令 交易1
            const arbSwapInstruction = createArbSwapInstruction(
                swapInstructionPayLoad
            );
            //log("套利指令构建成功！");

            // 构建Setup指令 交易1
            const setupInstructions = createSetupInstructions(setupInstructionPayLoad);

            // 构建Jito小费指令，先大号转给小号（0.001SOL+jitoTip） 
            const tipAmountLamports = jitoTip;

            //log("找到套利机会！预计利润（lamports):",estimateProfitMinusTip);
            //log("JITO小费：",jitoTip);

            const toProxyWalletLamports = 10000000 + tipAmountLamports;

            // 给 代理钱包 转帐指令 交易1
            const toProxyWalletTransferInstruction = createTransferTipInstruction(
                toProxyWalletLamports,
                sign_wallet,
                proxyWalletAccount.publicKey
            );

            // 设置转账compute limit 交易1
            const setComputeUnitLimitInstruction = setComputeUnitLimit(200000);

            // 设置转账compute limit 交易2
            const setComputeUnitLimitInstructionProxy = setComputeUnitLimit(500);

            // 代理钱包转回大号 0.009995 SOL指令 交易2
            const toMainWalletTransferInstruction = createTransferTipInstruction(
                9995000,
                proxy_sign_wallet,
                sign_wallet.publicKey
            );

            // 代理钱包转给jito 指令 交易2
            const tipTransferInstruction = createTransferTipInstruction(
                tipAmountLamports,
                proxy_sign_wallet,
                randomTipAccount
            );

            // 构建V0交易 主号发起 交易1
            const messageV0 = new TransactionMessage({
                payerKey: sign_wallet.publicKey,
                recentBlockhash: global.currentBlockhash,
                instructions: [setComputeUnitLimitInstruction, ...setupInstructions, arbSwapInstruction, toProxyWalletTransferInstruction],
            }).compileToV0Message(addressLookupTableAccounts);
            //log("V0编译成功！");

            // 构建V0交易 代理钱包发起 交易2 
            const messageV0Proxy = new TransactionMessage({
                payerKey: proxy_sign_wallet.publicKey,
                recentBlockhash: global.currentBlockhash,
                instructions: [ setComputeUnitLimitInstructionProxy,tipTransferInstruction, toMainWalletTransferInstruction],
            }).compileToV0Message();


            // 创建并签名交易 交易1
            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([payer]);
            //log("交易签名");

            // 创建并签名交易 交易2
            const transactionProxy = new VersionedTransaction(messageV0Proxy);
            transactionProxy.sign([proxyWalletAccount]);
            //log("交易签名！");

            // 序列化交易并转成 Base64 交易1
            const serializedTransaction = transaction.serialize();
            const base64Transaction = Buffer.from(
                serializedTransaction
            ).toString("base64");
            log(
                "Arb交易构建成功,预计利润：",
                estimateProfitMinusTip,
                " lamports | ",
                middleMint
            );

            // 序列化交易并转成 Base64 交易2
            const serializedTransactionProxy = transactionProxy.serialize();
            const base64TransactionProxy = Buffer.from(
                serializedTransactionProxy
            ).toString("base64");
            //log("Proxy交易构建成功");

            // 发送Jito bundle交易
            const data = await sendTransactionToJito(
                base64Transaction,
                base64TransactionProxy,
                jito_urls,
                server_ips
            );
            log(data[0]["data"], "使用IP:", data[0]["ip"]);
        } catch (error) {
            logError("出错重新开始", error);
            // 等待一段时间再重试（可选）
            await new Promise((resolve) => setTimeout(resolve, 1000)); // 1秒延迟再尝试
        }
    }
}

// 接收主线程消息
parentPort.on("message", async (message) => {
    if (message.type === 'init') {
        await initializeWorker(message.constants);
        const result = await arbtriage();
        parentPort.postMessage(result);
    }
});
