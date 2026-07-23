import React, { useState, useEffect, useCallback } from "react";
import { Trophy, Users, Clock, Lock, Flame, CheckCircle2 } from "lucide-react";

// ---------- Pricing model (matches the ledger tool) ----------
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

// Standard competition calendar: 4 workout days + 3 rest days per week
function weeklyCost(binId) {
  const bin = BINS.find((b) => b.id === binId) || BINS[0];
  return +(4 * bin.cost + 3 * REST_COST).toFixed(2);
}

function assignBin(weightKg) {
  const w = Number(weightKg) || 0;
  return (BINS.find((b) => w >= b.min && w <= b.max) || BINS[BINS.length - 1]).id;
}

const FEE = 125;
const MIN_ENTRANTS = 5;
const LEVELS = ["beginner", "intermediate", "advanced"];
const RUNNER_UP_SMALL = +(3 * REST_COST).toFixed(2); // 3 rest-day sachets
const THIRD_SMALL = +(2 * REST_COST).toFixed(2); // 2 rest-day sachets
const RUNNER_UP_BIG = +(6 * REST_COST).toFixed(2); // 6 rest-day sachets
const THIRD_BIG = +(3 * REST_COST).toFixed(2); // 3 rest-day sachets

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

async function safeGet(key, shared) {
  try {
    const r = await window.storage.get(key, shared);
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}
async function safeSet(key, value, shared) {
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
    const entry = { id: `${Date.now()}`, name: form.name.trim(), phone: form.phone.trim(), weight: Number(form.weight), bin, ts: Date.now() };
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
    const list = entrants[lv] || [];
    const lb = { ...leaderboard };
    const applyWin = (phone, place) => {
      const entrant = list.find((e) => e.phone === phone);
      if (!entrant) return;
      const rec = lb[phone] || { name: entrant.name, wins: 0, streak: 0, lastWonWeek: null };
      rec.name = entrant.name;
      if (place === 1) {
        rec.wins += 1;
        rec.streak = rec.lastWonWeek === config.weekId - 1 ? rec.streak + 1 : 1;
        rec.lastWonWeek = config.weekId;
      }
      lb[phone] = rec;
    };
    if (firstPhone) applyWin(firstPhone, 1);
    lb.__lastRecorded = lb.__lastRecorded || {};
    await safeSet("pi-comp:leaderboard", lb, true);
    setLeaderboard(lb);

    const history = (await safeGet("pi-comp:history", true)) || [];
    history.push({ weekId: config.weekId, level: lv, first: firstPhone, second: secondPhone, third: thirdPhone });
    await safeSet("pi-comp:history", history, true);
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
      <div className="max-w-md mx-auto px-4 py-6">
        <div className="mb-6 border-b border-stone-800 pb-4">
          <p className="text-xs tracking-widest text-amber-500 font-mono uppercase mb-1">Pumping Iron</p>
          <h1 className="text-2xl font-black text-stone-50 tracking-tight">Weekly Challenge</h1>
          <p className="text-stone-500 text-sm mt-1">Entry {KSh(FEE)} · Weigh-in confirms your bin, judged level confirms your group</p>
        </div>

        <div className="flex gap-2 mb-5">
          {["register", "leaderboard"].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-md text-sm font-semibold capitalize transition-colors ${
                tab === t ? "bg-amber-500 text-stone-950" : "bg-stone-900 text-stone-400"
              }`}
            >
              {t}
            </button>
          ))}
          <button
            onClick={() => setAdminOpen((v) => !v)}
            className="px-3 py-2 rounded-md bg-stone-900 text-stone-500"
            title="Admin"
          >
            <Lock size={16} />
          </button>
        </div>

        {tab === "register" && (
          <>
            <div className="flex gap-2 mb-4">
              {LEVELS.map((lv) => (
                <button
                  key={lv}
                  onClick={() => setLevel(lv)}
                  className={`flex-1 py-1.5 rounded text-xs font-semibold capitalize border ${
                    level === lv ? "border-amber-500 text-amber-400 bg-amber-500/10" : "border-stone-800 text-stone-500"
                  }`}
                >
                  {lv}
                </button>
              ))}
            </div>

            <div className="bg-stone-900 border border-stone-800 rounded-lg p-4 mb-4">
              <div className="flex items-center justify-between text-xs text-stone-500 mb-2">
                <span className="flex items-center gap-1">
                  <Users size={13} /> {currentList.length} registered
                </span>
                <span className="flex items-center gap-1">
                  <Clock size={13} /> {config ? fmtCountdown(closeMs) : "..."}
                </span>
              </div>
              <div className="h-2 bg-stone-800 rounded-full overflow-hidden mb-2">
                <div
                  className="h-full bg-amber-500 transition-all"
                  style={{
                    width: `${Math.min(100, (currentList.length / (tier.nextTarget || currentList.length || 1)) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-xs text-stone-500">
                {tier.confirmed ? (
                  <span className="text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 size={12} /> Competition confirmed to run
                  </span>
                ) : (
                  `${MIN_ENTRANTS - currentList.length} more to confirm this runs`
                )}
              </p>
            </div>

            <div className="bg-stone-900 border border-stone-800 rounded-lg p-4 mb-4">
              <p className="text-xs font-mono uppercase text-stone-500 mb-2 flex items-center gap-1">
                <Trophy size={13} className="text-amber-500" /> Prizes unlocked
              </p>
              <div className="space-y-1.5 text-sm">
                <p className={tier.confirmed ? "text-stone-200" : "text-stone-600"}>
                  🥇 1st — winner's own weight-class weekly pack
                </p>
                <p className={tier.second ? "text-stone-200" : "text-stone-600"}>
                  🥈 2nd — {tier.second ? tier.secondLabel : `unlocks at ${MIN_ENTRANTS + 3} entrants`}
                </p>
                <p className={tier.third ? "text-stone-200" : "text-stone-600"}>
                  🥉 3rd — {tier.third ? tier.thirdLabel : `unlocks at ${MIN_ENTRANTS + 7} entrants`}
                </p>
              </div>
              {tier.nextTarget && (
                <p className="text-[11px] text-stone-600 mt-2">
                  {tier.nextTarget - currentList.length} more entrants unlocks the next prize
                </p>
              )}
            </div>

            {registered ? (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 text-sm">
                <p className="text-emerald-400 font-semibold mb-1">You're in, {registered.name}</p>
                <p className="text-stone-400">
                  Weight class <span className="text-stone-200 font-mono">{registered.bin}</span> · {level} group
                </p>
                <p className="text-stone-500 mt-1">Pay {KSh(FEE)} to confirm your spot.</p>
              </div>
            ) : (
              <div className="bg-stone-900 border border-stone-800 rounded-lg p-4 space-y-3">
                <input
                  placeholder="Full name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full bg-stone-950 border border-stone-800 rounded px-3 py-2 text-sm"
                />
                <input
                  placeholder="Phone (M-Pesa number)"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  className="w-full bg-stone-950 border border-stone-800 rounded px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  placeholder="Weight (kg)"
                  value={form.weight}
                  onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))}
                  className="w-full bg-stone-950 border border-stone-800 rounded px-3 py-2 text-sm"
                />
                {form.weight && (
                  <p className="text-xs text-stone-500">Weight class: {assignBin(form.weight)}</p>
                )}
                {alreadyIn && <p className="text-xs text-red-400">This phone number is already registered this week.</p>}
                <button
                  onClick={handleRegister}
                  disabled={closeMs <= 0}
                  className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-stone-950 font-semibold text-sm py-2 rounded-md"
                >
                  Register — {KSh(FEE)}
                </button>
              </div>
            )}
          </>
        )}

        {tab === "leaderboard" && (
          <div className="space-y-2">
            {Object.entries(leaderboard)
              .filter(([k]) => k !== "__lastRecorded")
              .sort((a, b) => b[1].wins - a[1].wins)
              .map(([phone, rec]) => (
                <div key={phone} className="bg-stone-900 border border-stone-800 rounded-lg p-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-stone-200">{rec.name}</p>
                    <p className="text-xs text-stone-500">{rec.wins} win{rec.wins === 1 ? "" : "s"}</p>
                  </div>
                  {rec.streak >= 2 && (
                    <span className="flex items-center gap-1 text-xs bg-amber-500/20 text-amber-400 px-2 py-1 rounded font-mono">
                      <Flame size={12} /> {rec.streak} in a row{rec.streak >= 3 ? " — bonus earned!" : ""}
                    </span>
                  )}
                </div>
              ))}
            {Object.keys(leaderboard).filter((k) => k !== "__lastRecorded").length === 0 && (
              <p className="text-stone-600 text-sm text-center py-8">No results recorded yet.</p>
            )}
          </div>
        )}

        {adminOpen && (
          <div className="mt-6 border-t border-stone-800 pt-4">
            {!adminUnlocked ? (
              <div className="flex gap-2">
                <input
                  type="password"
                  placeholder="Admin passcode"
                  value={adminPass}
                  onChange={(e) => setAdminPass(e.target.value)}
                  className="flex-1 bg-stone-950 border border-stone-800 rounded px-3 py-2 text-sm"
                />
                <button onClick={handleAdminUnlock} className="bg-stone-800 px-4 rounded text-sm text-stone-300">
                  Unlock
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs font-mono text-stone-500 uppercase">Week #{config?.weekId} · Admin</p>
                {LEVELS.map((lv) => (
                  <AdminLevelPanel
                    key={lv}
                    level={lv}
                    entrants={entrants[lv] || []}
                    onRecord={(f, s, t) => recordWinners(lv, f, s, t)}
                  />
                ))}
                <button onClick={startNewWeek} className="w-full bg-red-500/20 text-red-400 text-sm py-2 rounded-md">
                  Start new week (clears all entrants)
                </button>
              </div>
            )}
          </div>
        )}
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