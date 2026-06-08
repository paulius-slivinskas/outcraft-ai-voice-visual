import { ShaderStage } from "../components/ShaderStage";
import {
  initialBackgroundColor,
  initialBlobs,
  initialMesh,
} from "../data/palette";

const idleAudioBands = Array(8).fill(0);

export default function VisualViewer() {
  return (
    <main className="app-shell" style={{ background: initialBackgroundColor }}>
      <ShaderStage
        audioBands={idleAudioBands}
        audioLevel={0}
        backgroundColor={initialBackgroundColor}
        blobs={initialBlobs}
        isPaused={false}
        mesh={initialMesh}
      />
    </main>
  );
}
