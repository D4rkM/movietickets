import { Transform } from "class-transformer";

/** Trims string input before validation, so "   " counts as empty. Non-strings pass through untouched. */
export const Trim = () => Transform(({ value }) => (typeof value === "string" ? value.trim() : value));
