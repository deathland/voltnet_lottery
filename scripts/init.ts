import * as anchor from "@coral-xyz/anchor";

// Utiliser les re-exports Anchor (évite les clashs de versions web3.js)
const { PublicKey, SystemProgram, LAMPORTS_PER_SOL } = anchor.web3;

// 👇 Ton Program ID déployé
const PROGRAM_ID_STR = "5JJV9foQ27twoVKKqcKhm1tKZhQQXgLCLykrde37rzaK";

// IDL minimal + metadata.address (Anchor n’ira pas chercher un idl inexistant)
const IDL: any = {
  version: "0.1.0",
  name: "voltnet_lottery",
  metadata: { address: PROGRAM_ID_STR },
  instructions: [
    {
      name: "initialize",
      accounts: [
        { name: "admin", isMut: true, isSigner: true },
        { name: "treasury", isMut: true, isSigner: false },
        { name: "state", isMut: true, isSigner: false },
        { name: "vault", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "ticketPriceLamports", type: "u64" },
        { name: "platformFeeBps", type: "u16" },
        { name: "rakeBps", type: "u16" },
        { name: "withdrawalFeeBps", type: "u16" },
        { name: "winnerBps", type: "u16" },
        { name: "rolloverBps", type: "u16" },
      ],
    },
  ],
};

function findStatePda(programId: anchor.web3.PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("state")], programId)[0];
}
function findVaultPda(programId: anchor.web3.PublicKey, statePda: anchor.web3.PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), statePda.toBuffer()], programId)[0];
}

(async () => {
  // ⚠️ AnchorProvider.env() exige ces 2 variables :
  if (!process.env.ANCHOR_PROVIDER_URL) throw new Error("ANCHOR_PROVIDER_URL is not defined");
  if (!process.env.ANCHOR_WALLET) throw new Error("ANCHOR_WALLET is not defined");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // 👉 Utilise PublicKey depuis anchor.web3 (pas @solana/web3.js direct)
  const programId = new PublicKey(PROGRAM_ID_STR);
  const program = new anchor.Program(IDL as any, programId, provider);

  const treasuryStr = process.env.TREASURY_PUBKEY;
  if (!treasuryStr) throw new Error("TREASURY_PUBKEY env var is required");

  const treasury = new PublicKey(treasuryStr);
  const statePda = findStatePda(programId);
  const vaultPda = findVaultPda(programId, statePda);

  const ticketPriceLamports = Math.round(Number(process.env.TICKET_PRICE_SOL || "0.1") * LAMPORTS_PER_SOL);
  const platformFeeBps      = Number(process.env.PLATFORM_FEE_BPS || "500");
  const rakeBps             = Number(process.env.RAKE_AT_PAYOUT_BPS || "500");
  const withdrawalFeeBps    = Number(process.env.WITHDRAWAL_FEE_BPS || "200");

  console.log("Init params →", {
    programId: programId.toBase58(),
    treasury: treasury.toBase58(),
    statePda: statePda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    ticketPriceLamports,
    platformFeeBps, rakeBps, withdrawalFeeBps,
    wallet: provider.wallet.publicKey.toBase58(),
    rpc: (provider.connection as any)._rpcEndpoint,
  });

  const sig = await program.methods
    .initialize(
      new anchor.BN(ticketPriceLamports),
      platformFeeBps,
      rakeBps,
      withdrawalFeeBps,
      5000, // 50% winner
      5000, // 50% rollover
    )
    .accounts({
      admin: provider.wallet.publicKey,
      treasury,
      state: statePda,
      vault: vaultPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("✅ Initialized");
  console.log("Tx:", sig);
})().catch((e) => {
  console.error("❌ Init failed:", e);
  process.exit(1);
});
