import * as anchor from "@coral-xyz/anchor";
import crypto from "crypto";

// On utilise les exports d'Anchor pour éviter les conflits de versions web3.js
const { PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction, TransactionInstruction } = anchor.web3;

const PROGRAM_ID_STR = "5JJV9foQ27twoVKKqcKhm1tKZhQQXgLCLykrde37rzaK"; // ton Program Id
const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);

// Discriminator Anchor: sha256("global:<name>").slice(0, 8)
function sighash(ixName: string): Buffer {
  return crypto.createHash("sha256").update(`global:${ixName}`).digest().slice(0, 8);
}

function findStatePda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("state")], programId)[0];
}
function findVaultPda(programId: PublicKey, statePda: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), statePda.toBuffer()], programId)[0];
}

(async () => {
  // ⚠️ Besoin de ces 2 variables
  if (!process.env.ANCHOR_PROVIDER_URL) throw new Error("ANCHOR_PROVIDER_URL is not defined");
  if (!process.env.ANCHOR_WALLET) throw new Error("ANCHOR_WALLET is not defined");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const treasuryStr = process.env.TREASURY_PUBKEY;
  if (!treasuryStr) throw new Error("TREASURY_PUBKEY env var is required");
  const treasury = new PublicKey(treasuryStr);

  const statePda = findStatePda(PROGRAM_ID);
  const vaultPda = findVaultPda(PROGRAM_ID, statePda);

  // Params
  const ticketPriceLamports = Math.round(Number(process.env.TICKET_PRICE_SOL || "0.1") * LAMPORTS_PER_SOL);
  const platformFeeBps      = Number(process.env.PLATFORM_FEE_BPS || "500");
  const rakeBps             = Number(process.env.RAKE_AT_PAYOUT_BPS || "500");
  const withdrawalFeeBps    = Number(process.env.WITHDRAWAL_FEE_BPS || "200");
  const winnerBps           = 5000; // 50%
  const rolloverBps         = 5000; // 50%

  // --- Construire le payload: [8 bytes discriminator] + u64 + 5 * u16 ---
  const disc = sighash("initialize");
  const data = Buffer.alloc(8 + 8 + 2*5);
  disc.copy(data, 0);
  let o = 8;
  data.writeBigUInt64LE(BigInt(ticketPriceLamports), o); o += 8;
  data.writeUInt16LE(platformFeeBps, o); o += 2;
  data.writeUInt16LE(rakeBps, o); o += 2;
  data.writeUInt16LE(withdrawalFeeBps, o); o += 2;
  data.writeUInt16LE(winnerBps, o); o += 2;
  data.writeUInt16LE(rolloverBps, o); o += 2;

  // Accounts (même ordre que dans ton programme Anchor)
  const keys = [
    { pubkey: provider.wallet.publicKey, isSigner: true,  isWritable: true  }, // admin
    { pubkey: treasury,                  isSigner: false, isWritable: true  }, // treasury
    { pubkey: statePda,                  isSigner: false, isWritable: true  }, // state (init)
    { pubkey: vaultPda,                  isSigner: false, isWritable: true  }, // vault (init)
    { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false }, // system
  ];

  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  const tx = new Transaction().add(ix);

  console.log("→ Sending initialize()", {
    programId: PROGRAM_ID.toBase58(),
    admin: provider.wallet.publicKey.toBase58(),
    treasury: treasury.toBase58(),
    statePda: statePda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    ticketPriceLamports,
    platformFeeBps, rakeBps, withdrawalFeeBps, winnerBps, rolloverBps,
  });

  const sig = await provider.sendAndConfirm(tx, []);
  console.log("✅ Initialized. Tx:", sig);
})().catch((e) => {
  console.error("❌ Init failed:", e);
  process.exit(1);
});
