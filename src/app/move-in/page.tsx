import { appName } from "@/lib/shops";

// The Windows program's "Restore a company from a move file" (company-move-design.md section 8). In the program's own
// window, the link to here (/move-in?choose=1, on the first-run page) opens the tray's file dialog instead
// (desktop/main.mjs), and ?home=1 goes back to the first-run page. Anywhere else this page says where the door is.
export default function MoveIn() {
  const name = appName();
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card card-pad w-full max-w-md space-y-3 text-sm">
        <h1 className="text-xl font-bold">Restore a company from a move file</h1>
        <p>
          A move file brings a company from another {name} (the hosted service, or another PC) to this one, with everything it holds. On the PC that runs {name}, right-click the {name} icon by the
          clock and choose <strong>Restore a company from a move file...</strong>, then pick the file.
        </p>
        <p className="muted">The file is read where it is, on this PC; it is never uploaded.</p>
      </div>
    </div>
  );
}
