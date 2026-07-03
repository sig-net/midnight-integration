```
├── LICENSE
├── README.md
├── package-lock.json
├── package.json
|   # npm compile vault-contract
|   # npm unit-test vault-contract
|   # npm intergration-test vault-contract
|   # npm deploy vault-contract
|   # npm deploy signature-responses-contract
|   # npm run ui
├── tsconfig.base.json
└── packages
    ├── lib # @midnight-erc20-demo/lib
    │   ├── package.json
    │   ├── src
    │   │   ├── config.ts
    │   │   ├── index.ts
    │   │   ├── network.ts
    │   │   ├── seed.ts
    │   │   └── wallet.ts
    │   └── tsconfig.json
    │
    ├── deploy
    │   ├── README.md
    │   ├── package.json
    │   ├── src
    │   │   ├── config.ts
    │   │   ├── contract.ts
    │   │   ├── main.ts
    │   │   ├── providers.ts
    │   │   └── wallet.ts
    │   └── tsconfig.json
    │    
    ├── vault-contract # @midnight-erc20-demo/vault-contract-sdk
    │   ├── package.json
    │   ├── src
    │   │   └── shared-canvas.compact
    │   ├── tests
    │   │   └── contract.test.ts
    │   └── tsconfig.json
    │
    ├── vault-contract-sdk # @midnight-erc20-demo/lib
    │   ├── README.md
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── managed
    │   │   ├── compiler
    │   │   ├── contract
    │   │   ├── keys
    │   │   └── zkir
    │   └── src
    │       └── index.ts
    │
    ├── vault-contract # @midnight-erc20-demo/vault-contract
    │   ├── package.json
    │   ├── src
    │   │   └── shared-canvas.compact
    │   ├── tests
    │   │   └── contract.test.ts
    │   └── tsconfig.json
    │    
    ├── signature-responses-contract-sdk # @midnight-erc20-demo/signature-responses-contract-sdk
    │   ├── README.md
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── managed
    │   │   ├── compiler
    │   │   ├── contract
    │   │   ├── keys
    │   │   └── zkir
    │   └── src
    │       └── index.ts
    │
    ├── integration-tests # @midnight-erc20-demo/integration-tests
    │   ├── README.md
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── vitest.config.ts
    │   └── src
    │       ├── lib
    │       │   ├── config.ts
    │       │   ├── contract.ts
    │       │   ├── providers.ts
    │       │   └── wallet.ts
    │       └── tests
    │           ├── 1-environment.test.ts
    │           ├── 2-compile.test.ts
    │           ├── 3-account.test.ts
    │           ├── 4-deploy.test.ts
    │           └── 5-interactions
    │
    └── ui # @midnight-erc20-demo/ui
        ├── README.md
        ├── index.html
        ├── package.json
        └── tsconfig.json
```