import 'dotenv/config';
import { ethers, Provider, Wallet } from 'ethers';
import { unwrap } from './utils';

const SIMPLE_TX_INTERVAL = 300000; // 300sec

const simpleTx = async (provider: Provider, wallet: Wallet) => {
    while(true) {
        const tx = {
            to: wallet.address,
            value: 1, // just 1 wei
        };
        const startTime = Date.now();
        const txResponse = await wallet.sendTransaction(tx);
        console.log("tx sent in", Date.now() - startTime, "ms");
        await txResponse.wait(1); // included in a block
        console.log("tx mined in", Date.now() - startTime, "ms");
        // sleep 300sec
        await new Promise(resolve => setTimeout(resolve, SIMPLE_TX_INTERVAL));
    }
}

const main = async () => {
    const provider = new ethers.JsonRpcProvider(unwrap(process.env.CHAIN_RPC_URL));
    const wallet = new ethers.Wallet(unwrap(process.env.WALLET_KEY), provider);
    console.log("Hello World! balance is", ethers.formatEther(await provider.getBalance(wallet.address)));
    simpleTx(provider, wallet);
}

main()