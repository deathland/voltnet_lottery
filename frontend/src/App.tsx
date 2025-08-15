import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import "@solana/wallet-adapter-react-ui/styles.css";

// ---------- Polyfills Buffer/global (Vite) ----------
import { Buffer } from "buffer";
if (typeof globalThis !== "undefined") {
  // @ts-ignore
  globalThis.Buffer = globalThis.Buffer || Buffer;
  // @ts-ignore
  globalThis.global = globalThis.global || globalThis;
  // @ts-ignore
  globalThis.process = globalThis.process || { env: {} };
}

// ---------- Config ----------
type SupportedCluster = "devnet" | "mainnet-beta";
const CLUSTER: SupportedCluster =
  (import.meta.env.VITE_SOLANA_CLUSTER as SupportedCluster) || "devnet";

const DEFAULT_ENDPOINT = clusterApiUrl(CLUSTER);
const RPC_ENDPOINT: string =
  (import.meta.env.VITE_SOLANA_RPC as string) || DEFAULT_ENDPOINT || "https://api.devnet.solana.com";

const PROGRAM_ID_STR = (import.meta.env.VITE_PROGRAM_ID as string) || "";
const PROGRAM_ID = PROGRAM_ID_STR ? new PublicKey(PROGRAM_ID_STR) : null;

const ESCROW_WALLET = new PublicKey("4ZubhYsJvTLeVtggbtf5qw8oHmXBG4xDrzkZuracGSaa"); // fallback (sans programme)
const TREASURY_PUBKEY = new PublicKey(
  (import.meta.env.VITE_TREASURY_PUBKEY as string) || "4ZubhYsJvTLeVtggbtf5qw8oHmXBG4xDrzkZuracGSaa"
);

const RAW_TICKET_PRICE_SOL = Number.parseFloat(String(import.meta.env.VITE_TICKET_PRICE_SOL ?? "0.1"));
const TICKET_PRICE_SOL =
  Number.isFinite(RAW_TICKET_PRICE_SOL) && RAW_TICKET_PRICE_SOL > 0 ? RAW_TICKET_PRICE_SOL : 0.1;

const FEES = {
  PLATFORM_FEE_BPS: Number(import.meta.env.VITE_PLATFORM_FEE_BPS ?? 500),
  RAKE_AT_PAYOUT_BPS: Number(import.meta.env.VITE_RAKE_AT_PAYOUT_BPS ?? 500),
  WITHDRAWAL_FEE_BPS: Number(import.meta.env.VITE_WITHDRAWAL_FEE_BPS ?? 200),
  BUYBACK_BPS_OF_TREASURY: Number(import.meta.env.VITE_BUYBACK_BPS_OF_TREASURY ?? 0),
};

// ---------- Utils ----------
function formatSol(lamports: number) {
  return (lamports / LAMPORTS_PER_SOL).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function toLamports(sol: number) { return Math.round(sol * LAMPORTS_PER_SOL); }
function endOfCurrentMonth(): Date { const now = new Date(); return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59); }
function useCountdown(target: Date) {
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(v => v + 1), 1000); return () => clearInterval(t); }, []);
  const diff = Math.max(0, target.getTime() - Date.now());
  const s = Math.floor(diff / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return { d, h, m, s: sec };
}
function clusterQueryParam(cluster: SupportedCluster) { return cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`; }
function bps(amountLamports: number, bpsValue: number) { return Math.floor((amountLamports * bpsValue) / 10_000); }
function computeTicketSplit(count: number, unitPriceSol: number, platformFeeBps: number) {
  const totalLamports = toLamports(count * unitPriceSol);
  const feeLamports = bps(totalLamports, platformFeeBps);
  const jackpotLamports = totalLamports - feeLamports;
  return { totalLamports, feeLamports, jackpotLamports };
}
function u64ToLeBuffer(n: anchor.BN): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n.toString())); return b; }
function findStatePda(programId: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("state")], programId)[0]; }
function findVaultPda(programId: PublicKey, statePda: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("vault"), statePda.toBuffer()], programId)[0]; }
function findUserTicketsPda(programId: PublicKey, user: PublicKey, epoch: anchor.BN) {
  return PublicKey.findProgramAddressSync([Buffer.from("user_tickets"), user.toBuffer(), u64ToLeBuffer(epoch)], programId)[0];
}

// u64 en LE (pour fallback “raw ix”)
function u64LeFromNumber(n: number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
// Discriminator d’instruction Anchor (web crypto)
async function ixDiscriminator(name: string): Promise<Buffer> {
  const bytes = new TextEncoder().encode(`global:${name}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(new Uint8Array(hash)).subarray(0, 8);
}

// ---------- IDL minimal (any) ----------
const VOLTNET_IDL: any = {
  version: "0.1.0",
  name: "voltnet_lottery",
  instructions: [
    {
      name: "buyTickets",
      accounts: [
        { name: "user", isMut: true, isSigner: true },
        { name: "treasury", isMut: true, isSigner: false },
        { name: "state", isMut: true, isSigner: false },
        { name: "vault", isMut: true, isSigner: false },
        { name: "userTickets", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [{ name: "count", type: "u64" }],
    },
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

// ---------- Anim helpers ----------
function useAnimatedNumber(value: number, duration = 800) {
  const [display, setDisplay] = useState(value); const last = useRef(value);
  useEffect(() => {
    const start = performance.now(), from = last.current, to = value;
    const raf = (t: number) => { const p = Math.min(1, (t - start) / duration); const eased = 1 - Math.pow(1 - p, 3); setDisplay(from + (to - from) * eased); if (p < 1) requestAnimationFrame(raf); };
    requestAnimationFrame(raf); last.current = value;
  }, [value, duration]);
  return display;
}
function TiltCard({ children, className = "", style = {} }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState("perspective(900px) rotateX(0) rotateY(0)");
  const isTouch = typeof window !== "undefined" && matchMedia("(hover: none)").matches;
  const onMove = (e: React.MouseEvent) => {
    if (isTouch) return;
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    const rotY = (px - 0.5) * 10;
    const rotX = (0.5 - py) * 10;
    setTransform(`perspective(900px) rotateX(${rotX}deg) rotateY(${rotY}deg)`);
  };
  const onLeave = () => setTransform("perspective(900px) rotateX(0) rotateY(0)");
  return <div ref={ref} onMouseMove={onMove} onMouseLeave={onLeave} className={"card " + className} style={{ ...style, transform }}>{children}</div>;
}
function MagneticButton({ children, onClick, disabled, className = "" }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null); const [t, setT] = useState({ x: 0, y: 0 });
  const onMove = (e: React.MouseEvent) => { const el = ref.current; if (!el) return; const r = el.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width - .5) * 16; const y = ((e.clientY - r.top) / r.height - .5) * 16; setT({ x, y }); };
  const onLeave = () => setT({ x: 0, y: 0 });
  return (
    <button ref={ref} onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick} disabled={disabled}
      style={{ transform: `translate(${t.x}px, ${t.y}px)` }} className={"btn " + className + (disabled ? " btn-disabled" : "")}>
      <span className="btn-shine" />{children}
    </button>
  );
}

// ---------- Health check ----------
function HealthCheck({ connection }: { connection: Connection }) {
  const [ok, setOk] = useState<null | boolean>(null);
  const [msg, setMsg] = useState<string>("Checking…");
  const run = useCallback(async () => {
    try {
      const [ver, { blockhash }] = await Promise.all([connection.getVersion(), connection.getLatestBlockhash("confirmed")]);
      setOk(true); setMsg(`RPC OK • ${ver["solana-core"] || "?"} • ${blockhash.slice(0, 8)}…`);
    } catch (e: any) { setOk(false); setMsg(`RPC error • ${e?.message || String(e)}`); }
  }, [connection]);
  useEffect(() => { run(); const id = setInterval(run, 15000); return () => clearInterval(id); }, [run]);
  return (
    <div className={`chip ${ok === null ? "chip-muted" : ok ? "chip-good" : "chip-bad"}`}>
      <div><strong>RPC ({CLUSTER})</strong> → <code>{RPC_ENDPOINT}</code></div>
      <div className="chip-sub">{msg}</div>
    </div>
  );
}

// ---------- Cards ----------
function PotCard({ connection }: { connection: Connection }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setErr(null);
      if (PROGRAM_ID) {
        const statePda = findStatePda(PROGRAM_ID);
        const vaultPda = findVaultPda(PROGRAM_ID, statePda);
        const lamports = await connection.getBalance(vaultPda, "confirmed");
        setBalance(lamports);
      } else {
        const lamports = await connection.getBalance(ESCROW_WALLET, "confirmed");
        setBalance(lamports);
      }
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [connection]);
  useEffect(() => { refresh(); const id = setInterval(refresh, 6000); return () => clearInterval(id); }, [refresh]);
  const animated = useAnimatedNumber(balance ?? 0);
  return (
    <TiltCard>
      <div className="card-title">Current Jackpot</div>
      <div className="jackpot">{balance === null ? "—" : `${formatSol(animated)} SOL`}</div>
      <div className="small muted">
        {PROGRAM_ID ? <>Vault PDA: <code>{findVaultPda(PROGRAM_ID, findStatePda(PROGRAM_ID)).toBase58()}</code></>
                    : <>Escrow: <code>{ESCROW_WALLET.toBase58()}</code></>}
      </div>
      <div className="mt-16" />
      <button onClick={refresh} className="btn btn-secondary">Refresh</button>
      {err && <div className="error">❌ {err}</div>}
    </TiltCard>
  );
}

function FeePolicyCard() {
  const buybackInfo =
    FEES.BUYBACK_BPS_OF_TREASURY > 0
      ? `${FEES.BUYBACK_BPS_OF_TREASURY / 100}% of treasury used for buyback (off-chain policy)`
      : `Treasury may perform buybacks (off-chain policy)`;
  return (
    <TiltCard>
      <div className="card-title">Transparent Fee Policy</div>
      <ul className="list">
        <li>Platform fee per ticket: <strong>{FEES.PLATFORM_FEE_BPS / 100}%</strong> → Treasury.</li>
        <li>Rake at payout (from jackpot): <strong>{FEES.RAKE_AT_PAYOUT_BPS / 100}%</strong> → Treasury.</li>
        <li>Ticket split = Jackpot + Platform fee at purchase.</li>
        <li>Buyback & burn: {buybackInfo}.</li>
        <li>Winner withdrawal fee: <strong>{FEES.WITHDRAWAL_FEE_BPS / 100}%</strong>.</li>
      </ul>
      <div className="small muted mt-8">Exact enforcement is on-chain (Anchor program + PDA vault). VRF guarantees unbiased draws.</div>
    </TiltCard>
  );
}

function BuyTickets({ connection }: { connection: Connection }) {
  const wallet = useWallet();
  const { publicKey, sendTransaction } = wallet;

  const [count, setCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  const needLamports = useMemo(() => toLamports(count * TICKET_PRICE_SOL), [count]);
  const totalSol = useMemo(() => (count <= 0 ? 0 : count * TICKET_PRICE_SOL), [count]);

  // Balance utilisateur (pour airdrop / message)
  const refreshBalance = useCallback(async () => {
    if (!publicKey) return setBalance(null);
    try { const lamports = await connection.getBalance(publicKey, "confirmed"); setBalance(lamports); } catch {}
  }, [connection, publicKey]);
  useEffect(() => { refreshBalance(); }, [refreshBalance]);

  const preview = useMemo(() => {
    const { totalLamports, feeLamports, jackpotLamports } = computeTicketSplit(
      count, TICKET_PRICE_SOL, FEES.PLATFORM_FEE_BPS
    );
    return { totalLamports, feeLamports, jackpotLamports };
  }, [count]);

  // Fallback : envoie l’ix "buy_tickets" manuellement si Anchor bug (_bn)
  const sendRawBuy = useCallback(async () => {
    if (!PROGRAM_ID || !publicKey) throw new Error("Program or wallet missing");

    const provider = new anchor.AnchorProvider(connection as any, {} as any, { commitment: "confirmed" });
    const program  = new anchor.Program(VOLTNET_IDL as any, PROGRAM_ID, provider);

    const statePda = findStatePda(PROGRAM_ID);
    const vaultPda = findVaultPda(PROGRAM_ID, statePda);
    const state: any = await program.account.lotteryState.fetch(statePda);
    const epoch = new anchor.BN(state.epoch.toString());
    const userTicketsPda = findUserTicketsPda(PROGRAM_ID, publicKey, epoch);

    const disc = await ixDiscriminator("buy_tickets"); // nom exact côté Rust
    const data = Buffer.concat([disc, u64LeFromNumber(count)]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: publicKey,            isSigner: true,  isWritable: true  },
        { pubkey: TREASURY_PUBKEY,      isSigner: false, isWritable: true  },
        { pubkey: statePda,             isSigner: false, isWritable: true  },
        { pubkey: vaultPda,             isSigner: false, isWritable: true  },
        { pubkey: userTicketsPda,       isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = publicKey;
    const sig = await sendTransaction(tx, connection);
    return sig;
  }, [connection, publicKey, count]);

  const airdrop = useCallback(async () => {
    try {
      if (CLUSTER !== "devnet") throw new Error("Airdrop only on devnet");
      if (!publicKey) throw new Error("Connect wallet first");
      setError(null); setLoading(true);
      const sig = await connection.requestAirdrop(publicKey, 0.5 * LAMPORTS_PER_SOL);
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      await refreshBalance();
    } catch (e: any) { setError(e?.message || "Airdrop failed"); }
    finally { setLoading(false); }
  }, [connection, publicKey, refreshBalance]);

  const onBuy = useCallback(async () => {
    setError(null); setTxSig(null);
    if (!publicKey) { setError("Connecte d’abord ton wallet."); return; }
    if (count <= 0) { setError("Quantité invalide."); return; }
    if (balance !== null && balance < needLamports + 5_000) {
      setError("SOL insuffisant. Utilise l’airdrop (devnet) ou diminue la quantité.");
      return;
    }

    try {
      setLoading(true);
      if (PROGRAM_ID) {
        try {
          // ------- Flow Anchor -------
          const provider = new anchor.AnchorProvider(
            connection as any,
            {
              publicKey,
              signTransaction: wallet.signTransaction!,
              signAllTransactions: wallet.signAllTransactions!,
            } as unknown as anchor.Wallet,
            { commitment: "confirmed" }
          );
          const program = new anchor.Program(VOLTNET_IDL as any, PROGRAM_ID, provider);

          const statePda = findStatePda(PROGRAM_ID);
          const vaultPda = findVaultPda(PROGRAM_ID, statePda);
          const state = (await program.account.lotteryState.fetch(statePda)) as any;
          const epoch: anchor.BN = new anchor.BN(state.epoch.toString());
          const userTicketsPda = findUserTicketsPda(PROGRAM_ID, publicKey, epoch);

          const sig = await program.methods
            .buyTickets(new anchor.BN(count))
            .accounts({
              user: publicKey,
              treasury: TREASURY_PUBKEY,
              state: statePda,
              vault: vaultPda,
              userTickets: userTicketsPda,
              systemProgram: SystemProgram.programId,
            })
            .rpc();
          setTxSig(sig);
        } catch (e: any) {
          // _bn / translateAddress → fallback “raw”
          if (/_bn|translateAddress/i.test(String(e?.message || e))) {
            const sig = await sendRawBuy();
            setTxSig(sig);
          } else { throw e; }
        }
      } else {
        // ------- Fallback transfert simple -------
        const lamports = toLamports(totalSol);
        const tx = new Transaction().add(
          SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: ESCROW_WALLET, lamports })
        );
        tx.feePayer = publicKey;
        const sig = await sendTransaction(tx, connection);
        setTxSig(sig);
      }

      confetti({ particleCount: 140, spread: 70, origin: { y: 0.7 } });
      await refreshBalance();
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/insufficient/i.test(msg)) setError("SOL insuffisant. Fais un airdrop (devnet) ou alimente ton wallet.");
      else setError(msg);
    } finally { setLoading(false); }
  }, [publicKey, count, totalSol, connection, wallet, balance, needLamports, sendRawBuy, refreshBalance]);

  const explorerParam = clusterQueryParam(CLUSTER);

  return (
    <TiltCard>
      <div className="card-title">Buy tickets</div>

      {CLUSTER === "devnet" && publicKey && (
        <div className="small muted" style={{ marginBottom: 8 }}>
          Balance: {balance === null ? "—" : `${formatSol(balance)} SOL`} ·{" "}
          <button className="link" onClick={airdrop} disabled={loading} style={{ border: "none", background: "none", cursor: "pointer" }}>
            Airdrop 0.5 SOL (devnet)
          </button>
        </div>
      )}

      <div className="grid-3">
        <div>
          <div className="label">Count</div>
          <input type="number" min={1} value={count}
            onChange={(e) => setCount(parseInt(e.target.value || "1"))} className="input" />
        </div>
        <div><div className="label">Unit price</div><div className="input muted">{TICKET_PRICE_SOL} SOL</div></div>
        <div><div className="label">Total</div><div className="input strong">{totalSol.toLocaleString(undefined,{maximumFractionDigits:4})} SOL</div></div>
      </div>

      <div className="small muted mt-8">
        <div>Total (lamports): {preview.totalLamports}</div>
        <div>Platform fee ({FEES.PLATFORM_FEE_BPS / 100}%): {preview.feeLamports} lamports</div>
        <div>Jackpot share: {preview.jackpotLamports} lamports</div>
      </div>

      <div className="mt-16" />
      <MagneticButton onClick={onBuy} disabled={loading} className="w-full">
        {loading ? "Envoi…" : PROGRAM_ID ? "Buy (Program)" : "Buy"}
      </MagneticButton>

      <AnimatePresence>
        {txSig && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="success mt-12">
            ✅ Tx envoyée :{" "}
            <a className="link" href={`https://explorer.solana.com/tx/${txSig}${explorerParam}`} target="_blank" rel="noreferrer">
              voir dans l’Explorer
            </a>
          </motion.div>
        )}
      </AnimatePresence>
      {error && <div className="error mt-12">❌ {error}</div>}
      <div className="small muted mt-12">En achetant tu acceptes les règles. Aucune garantie de gains. Les frais sont affichés ci-dessus.</div>
    </TiltCard>
  );
}

function Countdown() {
  const end = useMemo(() => endOfCurrentMonth(), []);
  const { d, h, m, s } = useCountdown(end);
  const Box = ({ v, label }: { v: number; label: string }) => (
    <div className="countbox"><div className="countnum">{String(v).padStart(2, "0")}</div><div className="countlbl">{label}</div></div>
  );
  return (
    <TiltCard>
      <div className="label">Next draw</div>
      <div className="card-title">End of month</div>
      <div className="countgrid"><Box v={d} label="Days" /><Box v={h} label="Hours" /><Box v={m} label="Min" /><Box v={s} label="Sec" /></div>
      <div className="small muted mt-12">Winner receives 50% of the pot. Rollover keeps 50%.</div>
    </TiltCard>
  );
}

function Header() {
  return (
    <header className="header">
      <div className="brand"><div className="logo">⚡</div><div className="brandtxt">VoltNet Lottery</div></div>
      <WalletMultiButton className="walletbtn" />
    </header>
  );
}
function BackgroundFX() {
  const balls = useMemo(() => [7, 13, 23, 42].map((n, i) => ({ n, d: 6 + i * 1.3 })), []);
  return (
    <div className="bgfx" aria-hidden>
      <div className="stars" /><div className="aurora aurora-1" /><div className="aurora aurora-2" /><div className="grid" />
      {balls.map((b, idx) => (
        <motion.div key={idx} className="ball" style={{ left: `${10 + idx * 20}%`, top: `${20 + (idx % 2) * 25}%` }}
          animate={{ y: [0, -22, 0] }} transition={{ repeat: Infinity, duration: b.d, ease: "easeInOut" }}>
          {b.n}
        </motion.div>
      ))}
      <motion.div className="coin" initial={{ rotate: 0 }} animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 18, ease: "linear" }}>◎</motion.div>
    </div>
  );
}

// ---------- Screens ----------
function Landing() {
  return (
    <div className="screen">
      <BackgroundFX />
      <div className="container">
        <Header />
        <div className="hero">
          <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="hero-title">
            The fairest on-chain Lottery
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.6 }} className="hero-sub">
            Buy tickets. Grow the jackpot. A provably-fair draw picks the winner. Built on <span className="solana">Solana</span>.
          </motion.p>
          <div className="features">
            <div className="feature"><span>⚡</span> Instant finality</div>
            <div className="feature"><span>🔒</span> Non-custodial vault (PDA)</div>
            <div className="feature"><span>💎</span> Transparent fees</div>
          </div>
          <div className="cta"><WalletMultiButton className="cta-btn" /></div>
          <div className="note">Connecte ton wallet pour voir le pot en temps réel et acheter des tickets.</div>
        </div>
        <footer className="footer">© {new Date().getFullYear()} VoltNet — Built on Solana ({CLUSTER})</footer>
      </div>
    </div>
  );
}
function Dashboard() {
  const connection = useMemo(() => new Connection(RPC_ENDPOINT, "confirmed"), []);
  return (
    <div className="screen">
      <BackgroundFX />
      <div className="container">
        <Header />
        <div className="subinfo">
          <strong>Network:</strong> {CLUSTER} · <strong>Program:</strong> {PROGRAM_ID ? PROGRAM_ID.toBase58() : "(fallback transfer mode)"}
        </div>
        <div className="grid-main">
          <div className="col">
            <HealthCheck connection={connection} />
            <PotCard connection={connection} />
            <BuyTickets connection={connection} />
          </div>
          <div className="col">
            <Countdown />
            <FeePolicyCard />
          </div>
        </div>
        <footer className="footer">© {new Date().getFullYear()} VoltNet — Built on Solana ({CLUSTER})</footer>
      </div>
    </div>
  );
}
function Gate() { const { publicKey } = useWallet(); return publicKey ? <Dashboard /> : <Landing />; }

export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {/* Thème Neon Arcade (CSS inline) */}
          <style>{`
  :root{--bg:#070816;--ink:#e2e8f0;--muted:#94a3b8;--card:rgba(255,255,255,.06);--glass:rgba(255,255,255,.08);--border:rgba(255,255,255,.16);--brand1:#7c3aed;--brand2:#06b6d4;--brand3:#22d3ee;--ok:#10b981;--bad:#ef4444}
  *{box-sizing:border-box} html,body,#root{height:100%}
  body{margin:0;background:linear-gradient(180deg,#050616 0%,#0b1024 60%,#0b122b 100%);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif}
  .screen{min-height:100vh;position:relative;overflow:hidden}

  /* padding fluide pour s’adapter au mobile */
  .container{max-width:1120px;margin:0 auto;padding:clamp(14px,3.5vw,24px)}

  .header{display:flex;align-items:center;justify-content:space-between;padding:12px 0}
  .brand{display:flex;align-items:center;gap:12px}
  .logo{width:44px;height:44px;display:grid;place-items:center;border-radius:14px;background:linear-gradient(135deg,var(--brand1),var(--brand2));box-shadow:0 8px 24px rgba(124,58,237,.35)}
  .brandtxt{font-weight:900;font-size:22px;background:linear-gradient(90deg,var(--brand1),var(--brand2),var(--brand3));background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:sheen 7s linear infinite}
  .walletbtn{border-radius:12px !important}

  .subinfo{opacity:.85;margin:8px 0 24px 0;font-size:14px}

  .grid-main{display:grid;grid-template-columns:1fr;gap:24px}
  @media (min-width:860px){.grid-main{grid-template-columns:2fr 1fr}}
  .col{display:grid;gap:24px}

  .card{position:relative;padding:clamp(14px,3.2vw,22px);border:1px solid var(--border);border-radius:22px;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.04));backdrop-filter:blur(8px);box-shadow:0 10px 30px rgba(2,6,23,.35);transition:transform .2s ease}
  /* annule le tilt sur tactile */
  @media (hover:none){ .card{transform:none !important} }

  .card-title{font-weight:800;font-size:20px;margin-bottom:6px}
  .jackpot{margin-top:6px;font-size:clamp(32px,10vw,48px);font-weight:900;letter-spacing:-.02em;background:linear-gradient(90deg,var(--brand1),var(--brand2),var(--brand3));background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:sheen 6s linear infinite;text-shadow:0 6px 24px rgba(34,211,238,.35)}
  .label{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
  .list{margin:10px 0 0 0;padding-left:18px}
  .small{font-size:12px} .muted{color:var(--muted)} .success{color:#10b981} .error{color:#ef4444} .link{color:#60a5fa}

  .grid-3{display:grid;grid-template-columns:1fr;gap:12px;margin-top:14px}
  @media (min-width:860px){.grid-3{grid-template-columns:repeat(3,1fr)}}
  .input{width:100%;border:1px solid var(--border);border-radius:14px;padding:10px 12px;background:rgba(17,24,39,.35);color:var(--ink)} .input.strong{font-weight:700}

  .btn{position:relative;overflow:hidden;border:none;border-radius:18px;padding:14px 18px;font-weight:700;color:#fff;background:linear-gradient(90deg,var(--brand1),var(--brand2),var(--brand3));box-shadow:0 20px 40px rgba(124,58,237,.35);cursor:pointer}
  .btn:hover{filter:brightness(1.05)} .btn:active{filter:brightness(.95)} .btn.btn-disabled{opacity:.6;cursor:not-allowed}
  .btn-secondary{background:#0f172a;color:#fff;border:1px solid var(--border)}
  .btn-shine{position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(120deg,transparent,rgba(255,255,255,.25),transparent);animation:shine 2.6s linear infinite}

  .chip{border-radius:18px;padding:14px 16px;border:1px solid var(--border);background:rgba(255,255,255,.06)}
  .chip-sub{margin-top:4px;font-size:12px;opacity:.9}
  .chip-good{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.35);color:#d1fae5}
  .chip-bad{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35);color:#fee2e2}
  .chip-muted{opacity:.9}

  .countgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:12px}
  @media (max-width:480px){.countgrid{grid-template-columns:repeat(2,1fr)}}
  .countbox{border:1px solid var(--border);border-radius:16px;padding:10px 12px;background:rgba(255,255,255,.06);text-align:center}
  .countnum{font-size:28px;font-weight:900} .countlbl{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}

  .footer{padding:36px 0;text-align:center;color:var(--muted);font-size:13px}

  .hero{padding:60px 0 40px}
  .hero-title{font-size:clamp(28px,6.6vw,56px);line-height:1.05;margin:0;font-weight:900;letter-spacing:-.02em;background:linear-gradient(90deg,#fff,#e9d5ff,#a5f3fc);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 16px 40px rgba(99,102,241,.35)}
  .hero-sub{max-width:720px;margin-top:14px;opacity:.9}
  .features{display:flex;flex-wrap:wrap;gap:12px;margin-top:18px}
  .feature{border:1px dashed var(--border);border-radius:999px;padding:8px 12px;background:rgba(255,255,255,.05);backdrop-filter:blur(4px)}
  .cta{margin-top:24px} .cta-btn{border-radius:14px !important} .note{margin-top:10px;color:var(--muted)}

  /* background FX */
  .bgfx{position:absolute;inset:0;pointer-events:none}
  .stars{position:absolute;inset:0;background:radial-gradient(circle at 20% 20%,rgba(255,255,255,.06) 0 2px,transparent 2px),radial-gradient(circle at 80% 30%,rgba(255,255,255,.06) 0 2px,transparent 2px),radial-gradient(circle at 60% 70%,rgba(255,255,255,.06) 0 2px,transparent 2px);background-size:700px 700px,900px 900px,1100px 1100px;animation:stars 60s linear infinite}
  @keyframes stars{from{background-position:0 0,0 0,0 0}to{background-position:700px 700px,-900px 900px,1100px -1100px}}
  .aurora{position:absolute;filter:blur(64px);border-radius:999px;opacity:.6}
  .aurora-1{width:900px;height:900px;left:50%;transform:translateX(-50%);top:-360px;background:radial-gradient(circle at 70% 30%,rgba(124,58,237,.5),transparent),radial-gradient(circle at 30% 70%,rgba(34,211,238,.5),transparent)}
  .aurora-2{width:700px;height:700px;left:-180px;bottom:-260px;background:radial-gradient(circle at 20% 20%,rgba(14,165,233,.5),transparent),radial-gradient(circle at 80% 80%,rgba(59,130,246,.5),transparent)}
  .grid{position:absolute;inset:auto 0 0 0;height:320px;background-image:linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px);background-size:40px 40px;transform:perspective(700px) rotateX(60deg);transform-origin:bottom center;box-shadow:0 -60px 120px rgba(79,70,229,.25) inset}
  .ball{position:absolute;width:62px;height:62px;border-radius:999px;background:#fff;color:#0f172a;display:grid;place-items:center;font-weight:900;box-shadow:0 16px 40px rgba(255,255,255,.2)}
  .coin{position:absolute;right:8%;top:16%;font-size:40px;color:#a5f3fc;text-shadow:0 8px 24px rgba(165,243,252,.4)}

  /* micro-ajustements mobile */
  @media (max-width:520px){
    .header{flex-wrap:wrap;gap:10px}
    .walletbtn{width:100% !important;justify-content:center}
    .brandtxt{font-size:18px}
    .logo{width:36px;height:36px}
    .ball{width:44px;height:44px}
    .coin{display:none}
    .grid{height:240px}
  }
  .solana{color:#a78bfa}
`}</style>

          <Gate />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
