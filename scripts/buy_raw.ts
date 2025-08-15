import * as anchor from "@coral-xyz/anchor";
import crypto from "crypto";
const { PublicKey, SystemProgram, Transaction, TransactionInstruction } = anchor.web3;

const PROGRAM_ID = new PublicKey("5JJV9foQ27twoVKKqcKhm1tKZhQQXgLCLykrde37rzaK");
const TREASURY   = new PublicKey(process.env.TREASURY_PUBKEY!);

// sha256("global:<ixName>").slice(0,8)
function sighash(ix: string) {
  return crypto.createHash("sha256").update(`global:${ix}`).digest().slice(0, 8);
}
function statePda(pid: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("state")], pid)[0];
}
function vaultPda(pid: PublicKey, s: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), s.toBuffer()], pid)[0];
}
function userTicketsPda(pid: PublicKey, user: PublicKey, epochLe8: Buffer) {
  return PublicKey.findProgramAddressSync([Buffer.from("user_tickets"), user.toBuffer(), epochLe8], pid)[0];
}

(async () => {
  if (!process.env.ANCHOR_PROVIDER_URL) throw new Error("ANCHOR_PROVIDER_URL is not defined");
  if (!process.env.ANCHOR_WALLET) throw new Error("ANCHOR_WALLET is not defined");
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const user = provider.wallet.publicKey;
  const count = Number(process.env.COUNT || "1");
  if (!Number.isFinite(count) || count <= 0) throw new Error("Bad COUNT");

  const sPda = statePda(PROGRAM_ID);
  const vPda = vaultPda(PROGRAM_ID, sPda);

  // epoch = 0 tout de suite après l'init (sinon lire l'account et extraire)
  const epochLe = Buffer.alloc(8); epochLe.writeBigUInt64LE(0n);
  const utPda = userTicketsPda(PROGRAM_ID, user, epochLe);

  const data = Buffer.alloc(8 + 8);
  sighash("buy_tickets").copy(data, 0);
  data.writeBigUInt64LE(BigInt(count), 8);

  const keys = [
    { pubkey: user,   isSigner: true,  isWritable: true },
    { pubkey: TREASURY, isSigner: false, isWritable: true },
    { pubkey: sPda,   isSigner: false, isWritable: true },
    { pubkey: vPda,   isSigner: false, isWritable: true },
    { pubkey: utPda,  isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  const sig = await provider.sendAndConfirm(new Transaction().add(ix), []);
  console.log(`✅ buy_tickets x${count} →`, sig);
  console.log({ statePda: sPda.toBase58(), vaultPda: vPda.toBase58(), userTicketsPda: utPda.toBase58() });
})();
