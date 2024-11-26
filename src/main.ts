import 'dotenv/config';
import { ethers } from 'ethers';
import { unwrap } from './utils';

const main = async () => {
    const provider = new ethers.JsonRpcProvider(unwrap(process.env.RPC_URL));
    const wallet = new ethers.Wallet(unwrap(process.env.WALLET_KEY), provider);
    console.log("Hello World! balance is", ethers.formatEther(await provider.getBalance(wallet.address)));
}

main()