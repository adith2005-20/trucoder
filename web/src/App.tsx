import { useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./api";
import type { User } from "./types";
import Login from "./components/Login";
import Nav from "./components/Nav";
import CourseIndex from "./components/CourseIndex";
import CourseDashboard from "./components/CourseDashboard";
import LessonView from "./components/LessonView";
import Loader from "./components/Loader";
import SettingsModal from "./components/SettingsModal";
import CommandPalette from "./components/CommandPalette";
import ThemeSelector from "./components/ThemeSelector";
import AdminDashboard from "./components/AdminDashboard";
import {
  PiBookOpen,
  PiFileText,
  PiGearSix,
  PiHouse,
  PiKeyboard,
  PiMagnifyingGlass,
  PiPalette,
  PiSignOut,
} from "react-icons/pi";
import { registerCommandSection, type Command } from "./commands";
import { registerShortcut, useShortcuts } from "./shortcuts";
import { THEMES, useTheme } from "./theme";
import type { CourseDetail, CourseSummary, SearchEntry } from "./types";
import InterviewsIndex from "./interview/InterviewsIndex";
import InterviewWizard from "./interview/InterviewWizard";
import InterviewChat from "./interview/InterviewChat";

/** Lazy navigation index (courses + their lessons), cached 2 minutes. */
let navCache: { courses: CourseSummary[]; details: Record<string, CourseDetail> } | null =
  null;
let navCacheAt = 0;

/** Content-search index (server-built word lists per lesson), cached 10 min. */
let searchCache: SearchEntry[] | null = null;
let searchCacheAt = 0;
async function loadSearchIndex(): Promise<SearchEntry[]> {
  if (searchCache && Date.now() - searchCacheAt < 600_000) return searchCache;
  try {
    const r = await api.searchIndex();
    searchCache = r.lessons;
    searchCacheAt = Date.now();
  } catch {
    searchCache = searchCache ?? [];
  }
  return searchCache;
}
async function loadNavIndex(): Promise<{
  courses: CourseSummary[];
  details: Record<string, CourseDetail>;
}> {
  if (navCache && Date.now() - navCacheAt < 120_000) return navCache;
  try {
    const { courses } = await api.courses();
    const details: Record<string, CourseDetail> = {};
    await Promise.all(
      courses.map((c) =>
        api.course(c.id).then((d) => (details[c.id] = d)).catch(() => {}),
      ),
    );
    navCache = { courses, details };
    navCacheAt = Date.now();
    return navCache;
  } catch {
    return { courses: [], details: {} };
  }
}

function ThemeDot({ color }: { color: string }) {
  return <i className="cmd-theme-dot" style={{ background: color }} />;
}

function ThemeHint({ t }: { t: (typeof THEMES)[number] }) {
  return (
    <span className="cmd-theme-hint">
      <i style={{ background: t.colors.accent }} />
      <i style={{ background: t.colors.muted }} />
      <i style={{ background: t.colors.ink }} />
    </span>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [themePopOpen, setThemePopOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<
    "editor" | "theme" | "shortcuts" | "advanced"
  >("editor");
  const navigate = useNavigate();
  const { themeId, setThemeId } = useTheme();

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);

  // close the theme popover on Escape
  useEffect(() => {
    if (!themePopOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setThemePopOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [themePopOpen]);

  // ---- command palette sections (registered every render — replace-by-title)
  const themeCommands = useMemo<Command[]>(
    () =>
      THEMES.map((t) => ({
        id: `theme-${t.id}`,
        display: `Change theme — ${t.name}`,
        alias: `theme ${t.id} palette colors`,
        icon: <ThemeDot color={t.colors.accent} />,
        hint: <ThemeHint t={t} />,
        active: () => t.id === themeId,
        run: () => setThemeId(t.id),
      })),
    [themeId, setThemeId],
  );

  const loggedIn = user != null;
  registerCommandSection({
    title: "Navigate",
    commands: () =>
      loadNavIndex().then(({ courses, details }) => {
        const cmds: Command[] = [
          {
            id: "nav-home",
            display: "Go to dashboard",
            alias: "home index courses",
            icon: <PiHouse />,
            active: () => window.location.pathname === "/",
            run: () => navigate("/"),
          },
        ];
        for (const c of courses) {
          cmds.push({
            id: `nav-course-${c.id}`,
            display: `Open course — ${c.title}`,
            alias: c.id,
            icon: <PiBookOpen />,
            run: () => navigate(`/course/${c.id}`),
          });
          for (const l of details[c.id]?.lessons ?? []) {
            cmds.push({
              id: `nav-lesson-${c.id}-${l.id}`,
              display: `Go to lesson — ${l.title}`,
              alias: `${c.id} ${l.id} lesson`,
              icon: <PiFileText />,
              run: () => navigate(`/course/${c.id}/lessons/${l.id}`),
            });
          }
        }
        return cmds;
      }),
  });

  registerCommandSection({
    title: "Themes",
    commands: themeCommands,
  });

  registerCommandSection({
    title: "Search lessons",
    commands: () =>
      loadSearchIndex().then((entries) =>
        entries.map((e) => ({
          id: `search-${e.courseId}-${e.lessonId}`,
          display: `Find — ${e.title}`,
          alias: `${e.courseId} ${e.lessonId} ${e.words.join(" ")}`,
          icon: <PiMagnifyingGlass />,
          run: () => navigate(`/course/${e.courseId}/lessons/${e.lessonId}`),
        }))
      ),
  });

  registerCommandSection({
    title: "Settings",
    commands: [
      {
        id: "settings-open",
        display: "Open settings",
        alias: "preferences gear options",
        icon: <PiGearSix />,
        run: () => {
          setSettingsTab("editor");
          setSettingsOpen(true);
        },
      },
      {
        id: "settings-theme",
        display: "Open settings — theme",
        alias: "colors palette appearance",
        icon: <PiPalette />,
        run: () => {
          setSettingsTab("theme");
          setSettingsOpen(true);
        },
      },
      {
        id: "settings-shortcuts",
        display: "Open settings — shortcuts",
        alias: "keybinds keys hotkeys",
        icon: <PiKeyboard />,
        run: () => {
          setSettingsTab("shortcuts");
          setSettingsOpen(true);
        },
      },
    ],
  });

  if (loggedIn) {
    registerCommandSection({
      title: "Account",
      commands: [
        {
          id: "account-logout",
          display: "Log out",
          alias: "sign out exit",
          icon: <PiSignOut />,
          run: () => {
            api.logout().catch(() => {});
            setUser(null);
          },
        },
      ],
    });
  }

  // ---- site-wide shortcuts (⌘K palette, ⌘⇧T theme selector)
  registerShortcut({
    id: "palette",
    keys: "⌘+K",
    description: "Open the command palette",
    when: () => loggedIn,
    run: () => {
      setThemePopOpen(false);
      setPaletteOpen((o) => !o);
    },
  });
  registerShortcut({
    id: "theme-selector",
    keys: "⌘+⇧+T",
    description: "Toggle the theme selector",
    when: () => loggedIn,
    run: () => {
      setThemePopOpen((o) => !o);
      setPaletteOpen(false);
    },
  });
  useShortcuts();

  if (user === undefined) {
    return (
      <div className="center">
        <Loader />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {user && (
        <Nav
          user={user}
          onLogout={() => setUser(null)}
          themePopOpen={themePopOpen}
          onToggleThemePop={() => setThemePopOpen((o) => !o)}
          onOpenSettings={() => {
            setSettingsTab("editor");
            setSettingsOpen(true);
          }}
          onOpenPalette={() => {
            setThemePopOpen(false);
            setPaletteOpen(true);
          }}
        />
      )}
      <div className="route-body">
          <Routes>
            <Route
              path="/login"
              element={user ? <Navigate to="/" replace /> : <Login onLogin={setUser} />}
            />
            <Route
              path="/"
              element={user ? <CourseIndex /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/course/:courseId"
              element={user ? <CourseDashboard /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/course/:courseId/lessons/:lessonId"
              element={user ? <LessonView /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/interviews"
              element={user ? <InterviewsIndex /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/interviews/new"
              element={user ? <InterviewWizard /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/interviews/:id"
              element={user ? <InterviewChat /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/admin"
              element={
                user ? (
                  user.isOwner ? (
                    <AdminDashboard />
                  ) : (
                    <Navigate to="/" replace />
                  )
                ) : (
                  <Navigate to="/login" replace />
                )
              }
            />
            <Route
              path="*"
              element={<Navigate to={user ? "/" : "/login"} replace />}
            />
          </Routes>
      </div>

      {user && themePopOpen && (
        <div className="cmd-overlay" onMouseDown={() => setThemePopOpen(false)}>
          <div
            className="cmd-panel theme-overlay-panel"
            role="dialog"
            aria-label="theme selector"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <ThemeSelector />
          </div>
        </div>
      )}

      <CommandPalette open={paletteOpen && loggedIn} onClose={() => setPaletteOpen(false)} />

      {user && (
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          initialTab={settingsTab}
        />
      )}
    </div>
  );
}
