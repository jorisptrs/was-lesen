import { useState } from "react";
import { checkUnlocked, savePassphrase } from "../lib/api";

interface Props {
  onUnlocked: () => void;
}

/** The organizer's way in: everyone can browse the published map, but starting a run (and
 * publishing) needs the passphrase. Members never need this. */
export function UnlockPanel({ onUnlocked }: Props) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      if (await checkUnlocked(pw)) {
        savePassphrase(pw);
        onUnlocked();
      } else {
        setError("That's not it — try again.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="share">
      <button className="share-btn" onClick={() => setOpen((o) => !o)}>
        Show data
      </button>
      {open && (
        <div className="share-pop">
          <p className="share-hint">Enter the passphrase to start a run and publish the map.</p>
          {error && <p className="share-err">{error}</p>}
          <div className="share-url-row">
            <input
              className="share-url"
              type="password"
              placeholder="passphrase"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pw && !busy) void unlock();
              }}
            />
            <button className="btn primary" disabled={!pw || busy} onClick={unlock}>
              Unlock
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
