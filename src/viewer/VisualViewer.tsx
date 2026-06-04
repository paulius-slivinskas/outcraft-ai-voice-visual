import { ShaderStage, type ShaderStageHandle } from "../components/ShaderStage";
import { OverlayControl } from "../components/OverlayControl";
import { SwatchField } from "../components/data/palette";
import { useRef, useState } from "react";
import { VisualOverlayMark } from "../App";

export default function VisualViewer() {
  const stageRef = useRef<ShaderStageHandle | null>(null);
  const [backgroundColor, setBackgroundColor] = useState("#000000");
  const [blobs, setBlobs] = useState([]);
  const [mesh, setMesh] = useState({});
  const [visualOverlay, setVisualOverlay] = useState({ asset: "star", tone: "light" });

  return (
    <main className="app-shell" style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ position: "relative", width: 480, height: 480, borderRadius: "50%", overflow: "hidden", background: backgroundColor, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <ShaderStage
          ref={stageRef}
          backgroundColor={backgroundColor}
          blobs={blobs}
          mesh={mesh}
          isPaused={true}
        />
        <VisualOverlayMark overlay={visualOverlay} />
      </div>
      <div style={{ marginTop: 32 }}>
        <OverlayControl overlay={visualOverlay} onChange={setVisualOverlay} />
        <SwatchField label="Background" value={backgroundColor} onChange={setBackgroundColor} />
      </div>
    </main>
  );
}
