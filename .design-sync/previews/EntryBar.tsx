import { useState } from "react";
import { EntryBar } from "@seer/design-system";

export const Empty = () => {
  const [value, setValue] = useState("");
  return (
    <div style={{ width: 420 }}>
      <EntryBar value={value} onChange={setValue} />
    </div>
  );
};

export const Filled = () => (
  <div style={{ width: 420 }}>
    <EntryBar value="https://www.tiktok.com/@user/video/1234567890" label="Check" />
  </div>
);

export const AskMode = () => (
  <div style={{ width: 420 }}>
    <EntryBar value="" placeholder="Ask a follow-up…" label="Ask" />
  </div>
);

export const Disabled = () => (
  <div style={{ width: 420 }}>
    <EntryBar value="https://youtu.be/dQw4w9WgXcQ" disabled />
  </div>
);
