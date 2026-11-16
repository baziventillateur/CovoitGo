type Props = { text: string; yes: string; onYes: () => void; onNo: () => void };

// Fenêtre de confirmation aux couleurs de l'appli (remplace celle du navigateur).
export function ConfirmDialog({ text, yes, onYes, onNo }: Props) {
  return (
    <div className="sheet-backdrop middle" onClick={onNo}>
      <div className="dialog" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-emoji">🤔</div>
        <p>{text}</p>
        <button className="danger-btn big" onClick={onYes}>
          {yes}
        </button>
        <button className="ghost big" onClick={onNo}>
          Non, revenir
        </button>
      </div>
    </div>
  );
}
