import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import Home from './pages/Home';
import Room from './pages/Room';
import Brand from './components/Brand';

type Theme = 'light' | 'dark';
const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void }>({ theme: 'light', toggleTheme: () => undefined });
export function useTheme() { return useContext(ThemeContext); }
function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return localStorage.getItem('nextseat-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#20211f' : '#f5f3ee');
    try { localStorage.setItem('nextseat-theme', theme); } catch { /* Theme remains available for this session. */ }
  }, [theme]);
  return <ThemeContext.Provider value={{ theme, toggleTheme: () => setTheme((value) => value === 'light' ? 'dark' : 'light') }}>{children}</ThemeContext.Provider>;
}
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'light' ? 'dark' : 'light';
  return <button type="button" onClick={toggleTheme} className="theme-toggle" aria-label={'Switch to ' + next + ' mode'} title={'Switch to ' + next + ' mode'}><span aria-hidden="true">{theme === 'light' ? '☾' : '☀'}</span><span className="hidden sm:inline">{next === 'dark' ? 'Dark' : 'Light'}</span></button>;
}

function NotFound() {
  return (
    <main className="page-shell flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <Brand />
      <h1 className="text-3xl font-bold">We couldn’t find that page</h1>
      <p className="max-w-md text-gray-400">Check the room link or return home to create a new watch party.</p>
      <Link to="/" className="rounded-lg bg-blue-600 px-5 py-2.5 font-semibold hover:bg-blue-500">Go to home</Link>
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider><Routes>
        <Route path="/" element={<Home />} />
        <Route path="/r/:code" element={<Room />} />
        <Route path="*" element={<NotFound />} />
      </Routes></ThemeProvider>
    </BrowserRouter>
  );
}
