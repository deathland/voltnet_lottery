// scripts/get_state.ts
import * as anchor from "@coral-xyz/anchor";

// Utiliser les re-exports Anchor pour éviter les clashs de versions web3.js
const { PublicKey } = anchor.web3;

const PROGRAM_ID_STR = process.env.PROGRAM_ID || "5JJV9foQ27twoVKKqcKhm1tKZhQQXgLCLykrde37rzaK";
const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);

// IDL minimal + adresse dans metadata (le plus important)
const IDL: any = {
  version: "0.1.0",
  name: "voltnet_lottery",
  metadata: { address: PROGRAM_ID_STR },
  accounts: [
    {
      name: "lotteryState",
      type: {
        kind: "struct",
        fields: [
          { name: "admin", type: "publicKey" },
          { name: "treasury", type: "publicKey" },
          { name: "vault", type: "publicKey" },
          { name: "ticketPriceLamports", type: "u64" },
          { name: "platformFeeBps", type: "u16" },
          { name: "rakeBps", type: "u16" },
          { name: "withdrawalFeeBps", type: "u16" },
          { name: "winnerBps", type: "u16" },
          { name: "rolloverBps", type: "u16" },
          { name: "epoch", type: "u64" },
          { name: "drawOpen", type: "bool" },
        ],
      },
    },
  ],
};

function statePda(pid: anchor.web3.PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("state")], pid)[0];
}

(async () => {
  if (!process.env.ANCHOR_PROVIDER_URL || !process.env.ANCHOR_WALLET) {
    throw new Error("Set ANCHOR_PROVIDER_URL & ANCHOR_WALLET in env");
  }
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // ✅ Constructeur Program à 2 arguments
  const program = new (anchor as any).Program(IDL as any, provider as any);

  const stateKey = statePda(PROGRAM_ID);
  const state = await ((program as any).account as any)["lotteryState"].fetch(stateKey);

  console.log("State PDA:", stateKey.toBase58());
  console.log({
    admin: state.admin.toBase58?.() || state.admin,
    treasury: state.treasury.toBase58?.() || state.treasury,
    vault: state.vault.toBase58?.() || state.vault,
    ticketPriceLamports: state.ticketPriceLamports.toString?.() || state.ticketPriceLamports,
    platformFeeBps: state.platformFeeBps,
    rakeBps: state.rakeBps,
    withdrawalFeeBps: state.withdrawalFeeBps,
    winnerBps: state.winnerBps,
    rolloverBps: state.rolloverBps,
    epoch: state.epoch.toString?.() || state.epoch,
    drawOpen: state.drawOpen,
  });
})().catch((e) => {
  console.error("get_state failed:", e);
  process.exit(1);
});
