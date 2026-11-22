/** A custom video domain and page branding: Pro, Teams and owner (never Free). The one check every gate uses. */
export const canUseCustomBranding = (plan: string): boolean => plan === "pro" || plan === "teams" || plan === "owner";
