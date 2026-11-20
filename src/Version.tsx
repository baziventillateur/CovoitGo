import { useState } from "react";
import { createPortal } from "react-dom";
import { installUpdate, newVersionOnline } from "./pwa";

const VERSION = __VERSION__;

function when(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const time = d
    .toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    .replace(":", "h");
  return `${day} à ${time}`;
}

// Numéro de version discret dans l'en-tête ; au toucher, les dernières nouveautés et la
// vérification des mises à jour (comme dans NexBim).
export function VersionTag() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    "idle" | "checking" | "uptodate" | "updating" | "offline"
  >("idle");

  async function check() {
    setState("checking");
    try {
      if (await newVersionOnline()) {
        setState("updating");
        await installUpdate();
      } else setState("uptodate");
    } catch {
      setState("offline");
    }
  }

  return (
    <>
      <button
        type="button"
        className="version-tag"
        onClick={() => setOpen(true)}
        aria-label={`Version ${VERSION.number} de CovoitGo`}
      >
        v{VERSION.number}
      </button>
      {open &&
        // Hors de l'en-tête (son texte blanc et sa taille réduite ne doivent pas s'appliquer à la fenêtre).
        createPortal(
          <div className="sheet-backdrop middle" onClick={() => setOpen(false)}>
            <div
              className="dialog versions"
              role="dialog"
              aria-label="Versions de CovoitGo"
              onClick={(e) => e.stopPropagation()}
            >
              <strong className="versions-title">CovoitGo · versions</strong>
              <p className="versions-state">
                {state === "uptodate"
                  ? `Version ${VERSION.number} du ${when(VERSION.date)} : tu es à jour.`
                  : state === "updating"
                    ? "Nouvelle version trouvée : installation…"
                    : state === "offline"
                      ? "Vérification impossible : pas de connexion ?"
                      : `Version ${VERSION.number} du ${when(VERSION.date)}`}
              </p>
              {VERSION.history.length > 0 && (
                <>
                  <small className="versions-group">Dernières nouveautés</small>
                  <ul className="versions-list">
                    {VERSION.history.map((v) => (
                      <li key={v.number}>
                        <b>{v.number}</b>
                        <span>
                          {v.title.length > 110
                            ? `${v.title.slice(0, 108)}…`
                            : v.title}
                        </span>
                        <small>{when(v.date)}</small>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="row2">
                <button className="ghost" onClick={() => setOpen(false)}>
                  Fermer
                </button>
                <button
                  className="primary"
                  disabled={state === "checking" || state === "updating"}
                  onClick={check}
                >
                  {state === "checking"
                    ? "Vérification…"
                    : state === "updating"
                      ? "Mise à jour…"
                      : "Vérifier les mises à jour"}
                </button>
              </div>
            </div>
          </div>,
          document.querySelector(".app") ?? document.body,
        )}
    </>
  );
}
