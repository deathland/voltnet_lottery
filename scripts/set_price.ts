import * as anchor from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "crypto";

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "5JJV9foQ27twoVKKqcKhm1tKZhQQXgLCLykrde37rzaK");

function statePda(pid: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("state")], pid)[0];
}
function u64LE(n: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }
function disc(name: string) {
  return createHash("sha256").update("global:" + name).digest().subarray(0, 8);
}

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const admin = provider.wallet.publicKey;
  const newPriceSol = Number(process.env.NEW_TICKET_PRICE_SOL || process.argv[2] || "0.1");
  if (!Number.isFinite(newPriceSol) || newPriceSol <= 0) {
    throw new Error("NEW_TICKET_PRICE_SOL invalide (ex: 0.01) ou passe une valeur: ts-node scripts/set_price.ts 0.01");
  }
  const priceLamports = BigInt(Math.round(newPriceSol * LAMPORTS_PER_SOL));
  const state = statePda(PROGRAM_ID);

  console.log("→ Changer le prix…", {
    programId: PROGRAM_ID.toBase58(),
    admin: admin.toBase58(),
    statePda: state.toBase58(),
    newPriceSol,
  });

  // Essaie plusieurs noms possibles — ton lib.rs expose `set_ticket_price` dans #[program]
  const candidateNames = ["set_ticket_price", "setTicketPrice", "update_ticket_price", "updateTicketPrice"];

  const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");

  let sig: string | null = null;
  let lastErr: any = null;

  for (const name of candidateNames) {
    try {
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin, isSigner: true, isWritable: true },
          { pubkey: state, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([disc(name), u64LE(priceLamports)]),
      });

      const tx = new Transaction().add(ix);
      tx.recentBlockhash = blockhash;
      tx.feePayer = admin;

      sig = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
      console.log(`✅ Instruction "${name}" OK →`, sig);
      break;
    } catch (e: any) {
      lastErr = e;
      console.log(`… "${name}" a échoué: ${e?.message || e}`);
    }
  }

  if (!sig) {
    throw new Error(
      "Aucune variante n'a fonctionné. Vérifie que la fonction est bien dans #[program] et s’appelle set_ticket_price. " +
      "Dernière erreur: " + (lastErr?.message || String(lastErr))
    );
  }

  console.log("🎯 Nouveau prix:", newPriceSol, "SOL");
})();
