use crate::WatchdogFlow;
use ethers::abi::{Abi, Token};
use ethers::utils::rlp::RlpStream;
use ethers::{
    abi::{Address, Bytes},
    prelude::{PendingTransaction, *},
    providers::{Http, Provider},
    types::U256,
};
use std::str::FromStr;
use zksync_types::api::TransactionRequest;
use zksync_types::fee::Fee;
use zksync_types::transaction_request::{CallRequest, Eip712Meta, PaymasterParams};
use zksync_types::{
    web3, Eip712Domain, K256PrivateKey, L2ChainId, PackedEthSignature, EIP_712_TX_TYPE,
};

const PAYMASTER_ABI: &str = r#"
    [
      {
        "inputs": [
          {
            "internalType": "bytes",
            "name": "input",
            "type": "bytes"
          }
        ],
        "name": "general",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
      }
    ]
    "#;

/// This the number of pubdata such that it should be always possible to publish
/// from a single transaction. Note, that these pubdata bytes include only bytes that are
/// to be published inside the body of transaction (i.e. excluding of factory deps).
pub const DEFAULT_GAS_PER_PUBDATA_LIMIT: u64 = 50000;

pub struct PaymasterFlow {
    chain_id: u64,
    paymaster: Address,
    paymaster_encoded_input: Bytes,
    provider: Provider<Http>,
    private_key: K256PrivateKey,
}

impl PaymasterFlow {
    pub fn new(
        private_key: String,
        paymaster_address: String,
        chain_id: u64,
        provider: Provider<Http>,
    ) -> Self {
        let paymaster_contract: Abi =
            serde_json::from_str(PAYMASTER_ABI).expect("Failed to load the paymaster ABI");
        let paymaster_general_fn = paymaster_contract
            .function("general")
            .expect("Failed to get the general function");
        let paymaster_encoded_input = paymaster_general_fn
            .encode_input(&[Token::Bytes(vec![])])
            .expect("Failed to encode paymaster input");
        let private_key_bytes: H256 = private_key
            .parse()
            .expect("failed parsing private key bytes");
        let k256pk =
            K256PrivateKey::from_bytes(private_key_bytes).expect("private key bytes are invalid");

        Self {
            chain_id,
            paymaster: Address::from_str(paymaster_address.as_str()).ok().unwrap(),
            paymaster_encoded_input,
            provider,
            private_key: k256pk,
        }
    }

    async fn estimate_fee(&self) -> anyhow::Result<Fee> {
        let request = CallRequest {
            to: Some(self.private_key.address()),
            from: Some(self.private_key.address()),
            value: Some(U256::from(0u64)),
            transaction_type: Some(U64::from(EIP_712_TX_TYPE)),
            eip712_meta: Some(Eip712Meta {
                paymaster_params: Some(PaymasterParams {
                    paymaster: self.paymaster,
                    paymaster_input: self.paymaster_encoded_input.clone(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        Ok(self.provider.request("zks_estimateFee", [request]).await?)
    }
}

#[async_trait::async_trait]
impl WatchdogFlow for PaymasterFlow {
    async fn estimate_gas(&self) -> anyhow::Result<U256> {
        Ok(self.estimate_fee().await?.gas_limit)
    }

    async fn send_transaction(&self) -> anyhow::Result<PendingTransaction<Http>> {
        let address = self.private_key.address();
        let gas_price = self.provider.get_gas_price().await?;
        tracing::info!("Gas price {}", gas_price);
        let nonce = self.provider.get_transaction_count(address, None).await?;
        tracing::info!("Nonce {}", nonce);
        let fee = self.estimate_fee().await?;
        tracing::info!("Estimated fee {:?}", fee);

        let tx_request = TransactionRequest {
            nonce,
            to: Some(address),
            from: Some(address),
            value: U256::from(0u64),
            gas_price: fee.max_fee_per_gas,
            max_priority_fee_per_gas: Some(fee.max_priority_fee_per_gas),
            gas: fee.gas_limit,
            input: web3::Bytes::from(vec![]),
            transaction_type: Some(U64::from(EIP_712_TX_TYPE)),
            eip712_meta: Some(Eip712Meta {
                // should be high enough. If we use the one from fee estimate - the transaction might end up stuck in the mempool
                gas_per_pubdata: U256::from(DEFAULT_GAS_PER_PUBDATA_LIMIT),
                factory_deps: vec![],
                paymaster_params: Some(PaymasterParams {
                    paymaster: self.paymaster,
                    paymaster_input: self.paymaster_encoded_input.clone(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            chain_id: Some(self.chain_id),
            ..Default::default()
        };

        let msg = PackedEthSignature::typed_data_to_signed_bytes(
            &Eip712Domain::new(L2ChainId::from(self.chain_id as u32)),
            &tx_request,
        );
        let signature = PackedEthSignature::sign_raw(&self.private_key, &msg)?;

        let mut rlp = RlpStream::new();
        tx_request.rlp(&mut rlp, Some(&signature))?;
        let mut data = rlp.out().to_vec();
        data.insert(0, EIP_712_TX_TYPE);

        tracing::info!("Senfing transaction {:?}", tx_request);
        Ok(self.provider.send_raw_transaction(data.into()).await?)
    }
}
