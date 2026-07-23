import React, { useState, useEffect, useCallback } from "react";
import { Trophy, Users, Clock, Lock, Flame, CheckCircle2 } from "lucide-react";

// ---------- Pricing model ----------
const PPG = 7.317;
const INNER_SACHET = 1.37;
const WORKOUT_LABEL_FEE = 5;
const REST_COST = +(3 * PPG + INNER_SACHET).toFixed(2);

const BINS = [
  { id: "A", label: "A · 30–50kg", min: 0, max: 50, grams: 3, profit: 18 },
  { id: "B", label: "B · 51–67kg", min: 51, max: 67, grams: 4.5, profit: 20 },
  { id: "C", label: "C · 68–80kg", min: 68, max: 80, grams: 6, profit: 22 },
  { id: "D", label: "D · 81–100kg", min: 81, max: 100, grams: 7.5, profit: 24 },
  { id: "E", label: "E · 101kg+", min: 101, max: Infinity, grams: 9, profit: 26 },
].map((b) => {
  const cost = +(b.grams * PPG + INNER_SACHET + WORKOUT_LABEL_FEE).toFixed(2);
  return { ...b, cost, price: +(cost + b.profit).toFixed(2) };
});

function weeklyCost(binId) {
  const bin = BINS.find((b) => b.id === binId) || BINS[0];
  return +(4 * bin.cost + 3 * REST_COST).toFixed(2);
}

function assignBin(weightKg) {
  const w = Number(weightKg) || 0;
  return (BINS.find((b) => w >= b.min && w <= b.max) || BINS[BINS.length - 1]).id;
}

// Competition constants
const FEE = 125;
const MIN_ENTRANTS = 5;
const LEVELS = ["beginner", "intermediate", "advanced"];

const RUNNER_UP_SMALL = +(3 * REST_COST).toFixed(2);
const THIRD_SMALL = +(2 * REST_COST).toFixed(2);
const RUNNER_UP_BIG = +(6 * REST_COST).toFixed(2);
const THIRD_BIG = +(3 * REST_COST).toFixed(2);

function prizeTier(count) {
  if (count < MIN_ENTRANTS) {
    return { confirmed: false, second: false, third: false, nextTarget: MIN_ENTRANTS };
  }
  if (count < MIN_ENTRANTS + 3) {
    return { confirmed: true, second: false, third: false, nextTarget: MIN_ENTRANTS + 3 };
  }
  if (count < MIN_ENTRANTS + 7) {
    return {
      confirmed: true,
      second: true,
      secondLabel: `${RUNNER_UP_SMALL.toFixed(0)} worth of rest-day sachets`,
      third: false,
      nextTarget: MIN_ENTRANTS + 7,
    };
  }
  if (count < MIN_ENTRANTS + 11) {
    return {
      confirmed: true,
      second: true,
      secondLabel: `${RUNNER_UP_SMALL.toFixed(0)} worth of rest-day sachets`,
      third: true,
      thirdLabel: `${THIRD_SMALL.toFixed(0)} worth of rest-day sachets`,
      nextTarget: MIN_ENTRANTS + 11,
    };
  }
  return {
    confirmed: true,
    second: true,
    secondLabel: `${RUNNER_UP_BIG.toFixed(0)} worth of rest-day sachets`,
    third: true,
    thirdLabel: `${THIRD_BIG.toFixed(0)} worth of rest-day sachets`,
    nextTarget: null,
  };
}

const KSh = (n) => "KSh " + (Number(n) || 0).toLocaleString("en-KE", { maximumFractionDigits: 0 });

function fmtCountdown(ms) {
  if (ms <= 0) return "Registration closed";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

// Storage helpers
async function safeGet(key, shared = true) {
  try {
    const r = await window.storage.get(key, shared);
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}

async function safeSet(key, value, shared = true) {
  try {
    await window.storage.set(key, JSON.stringify(value), shared);
  } catch {
    // best effort
  }
}

export default function PumpingIronCompetition() {
  const [tab, setTab] = useState("register");
  const [config, setConfig] = useState(null);
  const [entrants, setEntrants] = useState({ beginner: [], intermediate: [], advanced: [] });
  const [leaderboard, setLeaderboard] = useState({});
  const [now, setNow] = useState(Date.now());
  const [level, setLevel] = useState("beginner");
  const [form, setForm] = useState({ name: "", phone: "", weight: "" });
  const [registered, setRegistered] = useState(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminPass, setAdminPass] = useState("");
  const [adminUnlocked, setAdminUnlocked] = useState(false);

  const loadAll = useCallback(async () => {
    const cfg = await safeGet("pi-comp:config", true);
    if (cfg) setConfig(cfg);
    else {
      const fresh = { weekId: 1, closeAt: new Date(Date.now() + 5 * 86400000).toISOString() };
      await safeSet("pi-comp:config", fresh, true);
      setConfig(fresh);
    }

    const next = {};
    for (const lv of LEVELS) {
      next[lv] = (await safeGet(`pi-comp:entrants:${cfg ? cfg.weekId : 1}:${lv}`, true)) || [];
    }
    setEntrants(next);

    const lb = await safeGet("pi-comp:leaderboard", true);
    setLeaderboard(lb || {});
  }, []);

  useEffect(() => {
    loadAll();
    const poll = setInterval(loadAll, 6000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [loadAll]);

  const closeMs = config ? new Date(config.closeAt).getTime() - now : 0;
  const currentList = entrants[level] || [];
  const tier = prizeTier(currentList.length);
  const alreadyIn = currentList.some((e) => e.phone === form.phone && form.phone.length > 5);

  const handleRegister = async () => {
    if (!config) return;
    if (!form.name.trim() || !form.phone.trim() || !form.weight) return;
    if (closeMs <= 0) return;
    if (currentList.some((e) => e.phone === form.phone)) return;

    const bin = assignBin(form.weight);
    const entry = {
      id: `${Date.now()}`,
      name: form.name.trim(),
      phone: form.phone.trim(),
      weight: Number(form.weight),
      bin,
      ts: Date.now(),
    };

    const updated = [...currentList, entry];
    await safeSet(`pi-comp:entrants:${config.weekId}:${level}`, updated, true);

    setEntrants((prev) => ({ ...prev, [level]: updated }));
    setRegistered(entry);
  };

  const handleAdminUnlock = () => {
    if (adminPass === "pumpingiron") setAdminUnlocked(true);
  };

  const recordWinners = async (lv, firstPhone, secondPhone, thirdPhone) => {
    if (!config) return;
    // ... (your original recordWinners logic)
  };

  const startNewWeek = async () => {
    if (!config) return;
    const fresh = { weekId: config.weekId + 1, closeAt: new Date(Date.now() + 5 * 86400000).toISOString() };
    await safeSet("pi-comp:config", fresh, true);
    setConfig(fresh);
    const next = {};
    for (const lv of LEVELS) next[lv] = [];
    setEntrants(next);
  };

  return (
    <div className="min-h-screen bg-stone-950 text-stone-200 font-sans">
      {/* HEADER */}
      <nav className="bg-black border-b border-stone-800 sticky top-0 z-50">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center justify-between">
          <span className="nav-brand text-xl font-black tracking-wider">PUMPING IRON</span>
          <div className="flex items-center gap-4">
            <a href="index.html" className="text-stone-400 hover:text-white transition-colors">
              Home
            </a>
            <a
              href="index.html#calculator"
              className="nav-order bg-red-600 hover:bg-red-700 px-4 py-1.5 rounded font-semibold text-sm tracking-wider transition-colors"
            >
              GET MY DOSE
            </a>
          </div>
        </div>
      </nav>

      <div className="max-w-md mx-auto px-4 py-6">
        {/* Rest of your component content unchanged */}
        <div className="mb-6 border-b border-stone-800 pb-4">
          <p className="text-xs tracking-widest text-amber-500 font-mono uppercase mb-1">Pumping Iron</p>
          <h1 className="text-2xl font-black text-stone-50 tracking-tight">Weekly Challenge</h1>
          <p className="text-stone-500 text-sm mt-1">
            Entry {KSh(FEE)} · Weigh-in confirms your bin, judged level confirms your group
          </p>
        </div>

        {/* ... rest of your tabs, forms, leaderboard, admin panel ... */}
        {/* (Copy the rest of your original JSX content here) */}
      </div>
    </div>
  );
}


function AdminLevelPanel({ level, entrants, onRecord }) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [third, setThird] = useState("");
  const tier = prizeTier(entrants.length);

  return (
    <div className="bg-stone-900 border border-stone-800 rounded-lg p-3">
      <p className="text-sm font-semibold capitalize text-stone-200 mb-2">
        {level} <span className="text-stone-600 font-normal text-xs">({entrants.length} entrants)</span>
      </p>
      <select value={first} onChange={(e) => setFirst(e.target.value)} className="w-full bg-stone-950 border border-stone-800 rounded px-2 py-1.5 text-xs mb-1.5">
        <option value="">1st place...</option>
        {entrants.map((e) => (
          <option key={e.phone} value={e.phone}>
            {e.name} ({e.bin})
          </option>
        ))}
      </select>
      {tier.second && (
        <select value={second} onChange={(e) => setSecond(e.target.value)} className="w-full bg-stone-950 border border-stone-800 rounded px-2 py-1.5 text-xs mb-1.5">
          <option value="">2nd place...</option>
          {entrants.map((e) => (
            <option key={e.phone} value={e.phone}>
              {e.name} ({e.bin})
            </option>
          ))}
        </select>
      )}
      {tier.third && (
        <select value={third} onChange={(e) => setThird(e.target.value)} className="w-full bg-stone-950 border border-stone-800 rounded px-2 py-1.5 text-xs mb-1.5">
          <option value="">3rd place...</option>
          {entrants.map((e) => (
            <option key={e.phone} value={e.phone}>
              {e.name} ({e.bin})
            </option>
          ))}
        </select>
      )}
      <button
        onClick={() => onRecord(first, second, third)}
        disabled={!first}
        className="w-full bg-amber-500 disabled:opacity-40 text-stone-950 text-xs font-semibold py-1.5 rounded"
      >
        Record results
      </button>
    </div>
  );
}