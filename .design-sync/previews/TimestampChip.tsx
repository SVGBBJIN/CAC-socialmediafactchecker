import { TimestampChip } from "@seer/design-system";

export const Default = () => <TimestampChip label="0:12" />;
export const Playing = () => <TimestampChip label="0:12-0:18" playing />;
export const Dead = () => <TimestampChip label="1:04" dead />;
export const Static = () => <TimestampChip label="0:42" static />;
