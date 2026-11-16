import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import Home from './pages/Home';
import Room from './pages/Room';
import Brand from './components/Brand';

function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-950 px-6 text-center text-white">
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
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/r/:code" element={<Room />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
