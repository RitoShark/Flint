import { parseThumbnailParams } from '../../lib/thumbnail/params';
import { ThumbnailEditor } from './ThumbnailEditor';

export function ThumbnailWindow() {
  const { project, skn } = parseThumbnailParams(window.location.hash);
  return <ThumbnailEditor project={project} skn={skn} />;
}
