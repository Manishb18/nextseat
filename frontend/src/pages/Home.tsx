export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
      <div className="w-full max-w-md space-y-8 px-6">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight">🎬 Watch Party</h1>
          <p className="mt-2 text-gray-400">
            Watch movies together, right in your browser.
          </p>
        </div>

        <div className="rounded-xl bg-gray-900 p-6 shadow-lg">
          <p className="text-center text-gray-500">
            Coming soon — room creation and joining.
          </p>
        </div>
      </div>
    </div>
  );
}
