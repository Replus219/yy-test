import {
    Connection,
    Keypair,
    VersionedTransaction,
    TransactionInstruction,
    TransactionMessage,
    PublicKey,
    AddressLookupTableAccount,
    Transaction,
    SystemProgram,
    ComputeBudgetProgram,
} from "@solana/web3.js";
import fetch from "cross-fetch";
import { Wallet } from "@project-serum/anchor";
import bs58 from "bs58";
import fs from "fs";
import toml from "toml";
import https from 'https';

//----------------------------------------------------------------------读取config配置-----------------------------------------------------------------------
// 读取并解析 TOML 配置文件
function loadConfig(filePath) {
    const data = fs.readFileSync(filePath, "utf8");
    return toml.parse(data);
}

// 导出加载的配置
export const config = loadConfig("./config.toml");

//----------------------------------------------------------------------生成钱包和提取钱包的utils-------------------------------------------------------------
// 生成X数量的solana地址存在本地json文件里
export function generateSolanaAddresses(count) {
    let wallets = [];

    for (let i = 0; i < count; i++) {
        const keypair = Keypair.generate();
        const address = keypair.publicKey.toString();
        const secretKey = bs58.encode(keypair.secretKey);

        wallets.push({ address, secretKey });
    }

    // 将所有地址和 Base58 格式的私钥保存到一个文件
    fs.writeFileSync(
        "solana_wallets_base58.json",
        JSON.stringify(wallets, null, 2)
    );
    console.log(
        `${count} addresses generated and saved to solana_wallets_base58.json.`
    );
}

// 从json文件里随机取一个地址
export function getRandomAddress() {
    // 读取文件内容并解析JSON
    const data = fs.readFileSync("solana_wallets_base58.json", "utf-8");
    const wallets = JSON.parse(data);

    // 随机选择一个钱包
    const randomWallet = wallets[Math.floor(Math.random() * wallets.length)];

    // 使用私钥生成Keypair实例
    const randomAddress = Keypair.fromSecretKey(
        bs58.decode(randomWallet.secretKey)
    );

    console.log("Random Address:", randomAddress.publicKey.toString());
    console.log("Private Key:", randomWallet.secretKey);

    return randomAddress;
}

//-----------------------------------------------------------------------------jupiter api utils----------------------------------------------------------------------
// 获取路径
export async function getQuote(inputMint, outputMint, amount, slippageBps) {
    try {
        const quoteResponse = await (
            await fetch(
                `http://${config.JUPITER_URL}:18080/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=${config.ONLYDIRECTROUTES}`
            )
        ).json();
        return quoteResponse;
    } catch (error) {
        console.error("获取报价时出错！");
        return null;
    }
}

// 获取swap-instruction
export async function getInstruction(combinedQuoteResponse, wallet) {
    try {
        const response = await fetch(
            `http://${config.JUPITER_URL}:18080/swap-instructions`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    quoteResponse: combinedQuoteResponse,
                    userPublicKey: wallet.publicKey.toString(),
                    useSharedAccounts: false,
                }),
            }
        );

        const instructions = await response.json();

        const {
            swapInstruction: swapInstructionPayLoad,
            setupInstructions: setupInstructionPayLoad,
            addressLookupTableAddresses: addressLookupTableAddresses,
        } = instructions;

        return {
            swapInstructionPayLoad,
            setupInstructionPayLoad,
            addressLookupTableAddresses,
        };
    } catch (error) {
        console.error("获取Swap指令时出错:", error);
        // 返回 null 或者根据你的需要返回一个默认值以便程序继续运行
        return null;
    }
}

//----------------------------------------------------------------------------链下utils--------------------------------------------------------------------------------
// 寻找机会
export async function find_opportunity(
    inputMint,
    outputMint,
    firstRouterAmount
) {
    try {
        const firstRouter = await getQuote(
            inputMint,
            outputMint,
            firstRouterAmount,
            100
        );
        if (!firstRouter) {
            console.error("第一次获取报价失败，跳过当前机会寻找。");
            return null;
        }
        const firstRouterOutAmount = firstRouter.outAmount;

        //console.log("第一次报价:", firstRouter);

        const secondRouter = await getQuote(
            outputMint,
            inputMint,
            firstRouterOutAmount,
            100
        );
        if (!secondRouter) {
            console.error("第二次获取报价失败，跳过当前机会寻找。");
            return null;
        }

        // 动态static tip
        //const jitoTip = parseInt((Number(secondRouter.outAmount) - Number(firstRouterAmount) - 10000) * config.JITO_STATIC_TIP_PERCENT);

        // 静态固定 tip
        const jitoTip = parseInt(config.JITO_STATIC_TIP);
 
        const estimateProfitMinusTip = parseInt((Number(secondRouter.outAmount) - Number(firstRouterAmount) - 10000)) - jitoTip;

        if (estimateProfitMinusTip > config.MIN_GAIN_LAMPORTS) {
            //console.log("找到套利机会！预计利润（lamports):",estimateProfitMinusTip);
            return { firstRouter, secondRouter, estimateProfitMinusTip,jitoTip };
        } else {
            //console.log("利润小于设定最小利润", estimateProfitMinusTip);
            return null;
        }
    } catch (error) {
        console.error("寻找套利机会时出错:", error);
        return null;
    }
}

// 计算不会亏损滑点(必须是当有利润时才会用到，不然会出错)
// 只能有合约才能设置，不然会出现按static比例给的贿赂费，实际上链不是按照0滑点的，但贿赂费是按照0滑点的，就会造成亏损
// export function calculateMaxSlippage(
//     inAmount,
//     tipPercentage,
//     estimatedProfitLamports,
//     estimatedOutAmountLamports
// ) {
//     const tipAmountLamports = (tipPercentage / 100) * estimatedProfitLamports; // 计算小费（以 Lamports 为单位）
//     const actualCostLamports = inAmount + tipAmountLamports; // 实际成本（以 Lamports 为单位）

//     // 使用公式计算滑点
//     const maxSlippage = 1 - actualCostLamports / estimatedOutAmountLamports;
//     // 将滑点转换为百分比并返回
//     return parseInt(maxSlippage * 10000 - 10); // 确保不返回负数
// }

// 混合有利润的两个router
export function combineTwoQuoteResponses(
    firstRouter,
    secondRouter,
    slippageBps
) {
    return {
        inAmount: firstRouter.inAmount,
        inputMint: firstRouter.inputMint,
        otherAmountThreshold: "0",
        outAmount: secondRouter.outAmount,
        outputMint: firstRouter.inputMint,
        routePlan: [...firstRouter.routePlan, ...secondRouter.routePlan],
        slippageBps: slippageBps,
        swapMode: "ExactIn",
        priceImpactPct: "0.0",
    };
}

// 构建Swap指令
export function createArbSwapInstruction(swapInstructionPayLoad) {
    return new TransactionInstruction({
        programId: new PublicKey(swapInstructionPayLoad.programId),
        keys: swapInstructionPayLoad.accounts.map((key) => ({
            pubkey: new PublicKey(key.pubkey),
            isSigner: key.isSigner,
            isWritable: key.isWritable,
        })),
        data: Buffer.from(swapInstructionPayLoad["data"], "base64"),
    });
}

// 构建Setup指令
export function createSetupInstructions(setupInstructionPayLoad) {
    const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
    
    // 过滤出需要的指令
    const filteredInstructions = setupInstructionPayLoad.filter(instruction => 
        instruction.programId === ASSOCIATED_TOKEN_PROGRAM_ID
    );

    return filteredInstructions.map(instruction => {
        return new TransactionInstruction({
            programId: new PublicKey(instruction.programId),
            keys: instruction.accounts.map(account => ({
                pubkey: new PublicKey(account.pubkey),
                isSigner: account.isSigner,
                isWritable: account.isWritable
            })),
            data: Buffer.from(instruction.data, 'base64')
        });
    });
}

// 构建TransferTip指令
export function createTransferTipInstruction(
    tipAmountLamports,
    tip_wallet,
    randomTipAccount
) {
    return SystemProgram.transfer({
        fromPubkey: tip_wallet.publicKey,
        toPubkey: new PublicKey(randomTipAccount),
        lamports: tipAmountLamports,
    });
}

//构建SetComputeUnitLimit指令
export function setComputeUnitLimit(limit) {
    const setComputeUnitLimitInstruction =
        ComputeBudgetProgram.setComputeUnitLimit({
            units: limit,
        });
    return setComputeUnitLimitInstruction;
}

//----------------------------------------------------------------------------链上utils--------------------------------------------------------------------------------

// 获取地址表地址，转换成V0能够接受的格式
export async function getAddressLookupTableAccounts(
    addressLookupTableAddresses,
    connection
) {
    const addressLookupTableAccountInfos =
        await connection.getMultipleAccountsInfo(
            addressLookupTableAddresses.map((key) => new PublicKey(key))
        );

    const addressLookupTableAccounts = addressLookupTableAccountInfos.reduce(
        (acc, accountInfo, index) => {
            const addressLookupTableAddress =
                addressLookupTableAddresses[index];
            if (accountInfo) {
                const addressLookupTableAccount = new AddressLookupTableAccount(
                    {
                        key: new PublicKey(addressLookupTableAddress),
                        state: AddressLookupTableAccount.deserialize(
                            accountInfo.data
                        ),
                    }
                );
                acc.push(addressLookupTableAccount);
            }
            return acc;
        },
        []
    );
    return addressLookupTableAccounts;
}

// 每秒更新blockhash
export async function updateBlockhash(connection) {
    try {
        const blockhash = await connection.getLatestBlockhash();
        global.currentBlockhash = blockhash.blockhash;
    } catch (error) {
        console.error("[Blockhash] 更新失败:", error);
    }
}

//--------------------------------------------------------------------给jito发交易-------------------------------------------------------------------
// 发送交易到单个 Jito URL
export async function sendTransactionToJito(base64Transaction, base64TransactionProxy, urls, serverIps) {
    const url = urls[0]; // 只使用第一个URL
    const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [
            [base64Transaction, base64TransactionProxy],
            {
                encoding: "base64",
            },
        ],
    };

    // 随机选择一个服务器IP
    const randomIp = serverIps[Math.floor(Math.random() * serverIps.length)];
    
    // 创建自定义的 https.Agent，指定本地IP和超时
    const agent = new https.Agent({
        localAddress: randomIp,
        timeout: 500,
        keepAlive: true
    });

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            agent: agent,
            timeout: 5000
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return [{ url, data, ip: randomIp }];
    } catch (error) {
        console.error(`[Jito] 发送交易到 ${url} 时出错:`, error.message);
        return [{ url, error: error.message, ip: randomIp }];
    }
}
