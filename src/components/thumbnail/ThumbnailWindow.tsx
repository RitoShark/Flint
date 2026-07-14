import { parseThumbnailParams } from '../../lib/thumbnail/params';
import { ThumbnailEditor } from './ThumbnailEditor';
import { ToastContainer } from '../overlays/Toast';

export function ThumbnailWindow() {
  const { project, skn } = parseThumbnailParams(window.location.hash);
  return (
    <>
      <ThumbnailEditor project={project} skn={skn} />
      {/* Standard Flint toast popups (export/import/save status) — the
          thumbnail window renders standalone (not App), so it mounts its own
          ToastContainer instead of the old inline `.tb-status` banner. */}
      <ToastContainer />
    </>
  );
}
