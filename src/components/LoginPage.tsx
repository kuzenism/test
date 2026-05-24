import { useState } from "react";
import { Zap, Eye, EyeOff, Shield } from "lucide-react";
import { motion } from "motion/react";

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    setTimeout(() => {
      if (username === "admin@admin123" && password === "admin123") {
        if (rememberMe) {
          localStorage.setItem("tele-auth", "1");
        } else {
          sessionStorage.setItem("tele-auth", "1");
        }
        onLogin();
      } else {
        setError("Username atau password salah.");
      }
      setLoading(false);
    }, 400);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-5 relative overflow-hidden"
      style={{ background: "linear-gradient(135deg, #0a0e17 0%, #1e1b4b 50%, #0f172a 100%)" }}
    >
      {/* Decorative orbs */}
      <div className="absolute top-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-indigo-500/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] left-[-10%] w-[400px] h-[400px] rounded-full bg-violet-500/10 blur-[100px] pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-[380px] relative z-10"
      >
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <motion.div
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="w-14 h-14 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-indigo-500/30"
          >
            <Zap className="w-7 h-7 text-white fill-current" />
          </motion.div>
          <h1 className="text-2xl font-bold text-white">TeleOffer</h1>
          <p className="text-sm text-slate-400 mt-1">Masuk untuk melanjutkan</p>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-white/10 shadow-2xl p-6 sm:p-7 space-y-4"
          style={{ background: "rgba(17,24,39,.6)", backdropFilter: "blur(24px)" }}
        >
          {/* Username */}
          <div>
            <label className="text-xs font-semibold text-slate-400 mb-1.5 block">
              Username
            </label>
            <div className="relative">
              <Shield size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={username}
                onChange={(e) => { setUsername(e.target.value); setError(""); }}
                placeholder="Username"
                autoComplete="username"
                className="w-full h-12 bg-white/5 border border-white/10 rounded-xl pl-10 pr-3 text-sm text-white outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 transition placeholder:text-slate-600"
              />
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="text-xs font-semibold text-slate-400 mb-1.5 block">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(""); }}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full h-12 bg-white/5 border border-white/10 rounded-xl px-3 pr-10 text-sm text-white outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 transition placeholder:text-slate-600"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition p-1"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Remember me */}
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <div className="relative shrink-0">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-4 h-4 rounded border border-white/20 peer-checked:bg-indigo-500 peer-checked:border-indigo-500 transition-colors flex items-center justify-center">
                {rememberMe && (
                  <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 10 8">
                    <path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </div>
            </div>
            <span className="text-xs text-slate-400">Ingat saya di perangkat ini</span>
          </label>

          {/* Error */}
          {error && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-xs text-rose-400 font-medium bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2.5"
            >
              {error}
            </motion.p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full h-12 bg-gradient-to-r from-indigo-500 to-violet-600 text-white font-semibold rounded-xl text-sm hover:from-indigo-600 hover:to-violet-700 disabled:opacity-50 transition-all shadow-lg shadow-indigo-500/25 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Memverifikasi...
              </>
            ) : "Masuk →"}
          </button>
        </form>

        <p className="text-center text-[11px] text-slate-600 mt-6">© {new Date().getFullYear()} kzndev</p>
      </motion.div>
    </div>
  );
}
