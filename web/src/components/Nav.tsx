import { Link } from "react-router-dom";
import {
  PiChartLineUp,
  PiMagnifyingGlass,
  PiPalette,
  PiSignOut,
  PiGearSix,
} from "react-icons/pi";
import { api } from "../api";
import type { User } from "../types";
import Mascot from "./Mascot";

export default function Nav({
  user,
  onLogout,
  themePopOpen,
  onToggleThemePop,
  onOpenSettings,
  onOpenPalette,
}: {
  user: User;
  onLogout: () => void;
  themePopOpen: boolean;
  onToggleThemePop: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
}) {
  return (
    <header className="nav">
      <Link to="/" className="brand">
        <Mascot size={22} />
        <span className="brand-tru">tru</span>
        <span className="brand-coder">coder</span>
      </Link>

      <button
        type="button"
        className="nav-search"
        onClick={onOpenPalette}
        aria-label="search and commands"
      >
        <PiMagnifyingGlass size={15} />
        <span className="nav-search-label">search</span>
        <kbd className="nav-kbd">⌘K</kbd>
      </button>

      <div className="nav-right">
        <span className="nav-user">{user.username}</span>

        {user.isOwner && (
          <Link
            to="/admin"
            className="ghost"
            title="admin"
            aria-label="admin"
          >
            <PiChartLineUp size={16} />
          </Link>
        )}

        <button
          className="ghost"
          onClick={onOpenSettings}
          title="settings"
          aria-label="settings"
        >
          <PiGearSix size={16} />
        </button>

        <button
          className={`ghost theme-btn ${themePopOpen ? "active" : ""}`}
          onClick={onToggleThemePop}
          title="theme"
          aria-label="theme"
          aria-expanded={themePopOpen}
          aria-haspopup="dialog"
        >
          <PiPalette size={16} />
        </button>

        <button
          className="ghost"
          onClick={async () => {
            await api.logout().catch(() => {});
            onLogout();
          }}
          title="log out"
          aria-label="log out"
        >
          <PiSignOut size={16} />
        </button>
      </div>
    </header>
  );
}
