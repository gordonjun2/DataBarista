import { Evaluator, IAgentRuntime, Memory, ModelClass, generateObjectArray, State, elizaLogger, composeContext } from "@elizaos/core";

// Types
interface ProfessionalProfile {
    // Core Identity
    platformAccounts: Array<{
        platform: "telegram" | "twitter" | "facebook" | "linkedin";
        username: string;
    }>;

    // Personal Information
    personal: {
        role?: string;
        skills?: string[];
        industries?: string[];
        experienceLevel?: "entry" | "mid" | "senior" | "executive";
        locations?: string[];
        interests?: string[];
        education?: string[];
        eventsAttended?: Array<{
            name: string;
            date?: string;
            location?: string;
        }>;
    };

    // Intentions & Preferences
    intention: {
        type: string;
        description: string;
        preferences: {
            requiredSkills?: string[];
            preferredIndustries?: string[];
            experienceLevel?: "entry" | "mid" | "senior" | "executive";
            locationPreferences?: string[];
            companySize?: "startup" | "SME" | "enterprise";
            remotePreference?: "onsite" | "remote" | "hybrid";
            contractType?: "full-time" | "part-time" | "freelance" | "internship";
        };
        budget?: string;
        timeline?: string;
        urgency?: "low" | "medium" | "high";
    };
}

export interface UserProfileCache {
    data: ProfessionalProfile;
    lastUpdated: number;
    extractionState?: {
        currentProfile: ProfessionalProfile;
        conversationHistory: string[];
    };
}

// Constants
const INITIAL_PROFILE: ProfessionalProfile = {
    platformAccounts: [],
    personal: {
        skills: [],
        industries: [],
        locations: [],
        interests: []
    },
    intention: {
        type: "",
        description: "",
        preferences: {}
    }
};


// Templates
const extractionTemplate = `
TASK: Extract professional profile attributes and focused intentions from conversation history.

Recent Messages:
{{recentMessages}}

Current Profile:
{{currentProfile}}

Format response as array of objects following this schema:
[{
    "personal": {
        // Current occupation status
        "currentPosition"?: {
            "title"?: string,
            "company"?: string,
            "industry"?: string,
            "status"?: "actively-looking" | "employed" | "freelancing" | "founder" | "student"
        },
        // Core professional attributes
        "skills"?: string[],
        "industries"?: string[],
        "experienceLevel"?: "entry" | "mid" | "senior" | "executive",
        "locations"?: string[],
        // Additional context
        "education"?: string[],
        "certifications"?: string[],
        "languages"?: string[]
    },
    "intention": {
        "type": "mentorship" | "networking" | "collaboration" | "seeking_job"
          | "hiring" | "funding" | "startup_growth" | "skill_development"
          | "consulting" | "speaking_opportunity",
        "description": string,
        "preferences": {
            "requiredSkills"?: string[],
            "preferredIndustries"?: string[],
            "experienceLevel"?: "entry" | "mid" | "senior" | "executive",
            "locationPreferences"?: string[],
            "remotePreference"?: "onsite" | "remote" | "hybrid",
            "contractType"?: "full-time" | "part-time" | "freelance" | "internship",
            "compensationRange"?: [number, number],
            "companySize"?: "startup" | "small" | "medium" | "large"
        }
    }
}]

Rules:
1. Extract current position from explicit statements ("I work at...", "Currently employed as...")
2. Derive status from context if not explicitly stated
3. Company names should be normalized to official names (e.g., "Google" not "big tech company")
4. Maintain previous extraction rules

Example Response:
[{
    "personal": {
        "currentPosition": {
            "title": "senior ai engineer",
            "company": "OpenAI",
            "industry": "artificial intelligence",
            "status": "employed"
        },
        "skills": ["llm fine-tuning", "python", "vector-databases"],
        "certifications": ["AWS Machine Learning Specialty"]
    },
    "intention": {
        "type": "collaboration",
        "description": "looking to collaborate on ai safety research projects",
        "preferences": {
            "requiredSkills": ["ai alignment", "python"],
            "companySize": "startup"
        }
    }
}]

Output an empty array if no new information found: [{}]`;

export const professionalProfileEvaluator: Evaluator = {
    name: "professionalProfileEvaluator",
    similes: ["EXTRACT_PROFESSIONAL_PROFILE", "GET_NETWORKING_PREFERENCES", "ANALYZE_BACKGROUND"],
    description: "Extracts and maintains professional profile information through stateful conversation processing. Choose this evaluator ONLY if there are new information about user's goals and professional background present in the last message.",

    validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
        try {
            const username = state?.senderName || message.userId;
            elizaLogger.info("Validating professionalProfileEvaluator", {
                username,
                messageId: message.id,
                messageContent: message.content.text.substring(0, 100) + "..."
            });

            return true;
        } catch (error) {
            elizaLogger.error("Error in professionalProfileEvaluator validate:", error);
            return false;
        }
    },

    handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<State | boolean> => {
        try {
            const username = state?.senderName || message.userId;
            const cacheKey = `${runtime.character.name}/${username}/data`;

            // Get or initialize profile from cache
            const cached = await runtime.cacheManager.get<UserProfileCache>(cacheKey);
            const currentProfile = cached?.data || INITIAL_PROFILE;

            // Initialize state if needed
            if (!state) {
                state = await runtime.composeState(message);
            }
            
            // Always ensure state has the latest profile from cache
            state.currentProfile = currentProfile;
            state = await runtime.updateRecentMessageState(state);

            elizaLogger.info("Current profile state:", {
                username,
                profile: JSON.stringify(currentProfile, null, 2)
            });

            // Handle platform account - Fix: Check client type from runtime
            if (currentProfile.platformAccounts.length === 0) {
                // Get the client type from the active clients
                const clients = runtime.clients;
                const client = Object.values(clients)[0];
                const platform = client?.constructor?.name?.replace('ClientInterface', '').toLowerCase() as "telegram" | "twitter";
                
                if (platform) {
                    currentProfile.platformAccounts.push({ platform, username });
                    elizaLogger.info("Added platform account:", {
                        platform,
                        username,
                        currentPlatformAccounts: currentProfile.platformAccounts
                    });
                }
            }

            // Extract new information
            const context = composeContext({
                template: extractionTemplate,
                state: {
                    ...state,
                    currentProfile: JSON.stringify(currentProfile, null, 2),
                }
            });

            const result = await generateObjectArray({
                runtime,
                context,
                modelClass: ModelClass.LARGE
            });

            if (!result || Object.keys(result).length === 0) {
                elizaLogger.info("No new information extracted from message", {
                    username,
                    messageContent: message.content.text
                });
                return state;
            }

            // Log extracted information
            const newInfo = result[0];
            elizaLogger.info("Extracted new information:", {
                username,
                extractedInfo: JSON.stringify(newInfo, null, 2)
            });

            // Merge new information with current profile
            const mergedProfile = mergeProfiles(currentProfile, newInfo);

            elizaLogger.info("Profile merge result:", {
                username,
                hasNewPersonal: !!newInfo.personal,
                hasNewIntention: !!newInfo.intention,
                currentProfile: JSON.stringify(currentProfile, null, 2),
                extractedInfo: JSON.stringify(newInfo, null, 2),
                mergedProfile: JSON.stringify(mergedProfile, null, 2)
            });

            // Save updated profile to cache
            const cacheData: UserProfileCache = {
                data: mergedProfile,
                extractionState: {
                    currentProfile: mergedProfile,
                    conversationHistory: [...(cached?.extractionState?.conversationHistory || []), message.content.text]
                },
                lastUpdated: Date.now()
            };

            await runtime.cacheManager.set(cacheKey, cacheData);

            // Update state with latest profile
            state.currentProfile = mergedProfile;

            return state;
        } catch (error) {
            elizaLogger.error("Error in professionalProfileEvaluator handler:", error);
            return false;
        }
    },

    examples: []
};

function mergeProfiles(current: ProfessionalProfile, newInfo: any): ProfessionalProfile {
    const merged = { ...current };

    // Merge personal information
    if (newInfo.personal) {
        merged.personal = {
            ...merged.personal,
            ...newInfo.personal,
            // Merge arrays without duplicates
            skills: [...new Set([...(merged.personal.skills || []), ...(newInfo.personal.skills || [])])],
            industries: [...new Set([...(merged.personal.industries || []), ...(newInfo.personal.industries || [])])],
            locations: [...new Set([...(merged.personal.locations || []), ...(newInfo.personal.locations || [])])],
            interests: [...new Set([...(merged.personal.interests || []), ...(newInfo.personal.interests || [])])]
        };
    }

    // Update intention
    if (newInfo.intention) {
        merged.intention = {
            type: newInfo.intention.type || merged.intention.type,
            description: newInfo.intention.description || merged.intention.description,
            preferences: {
                ...merged.intention.preferences,
                ...newInfo.intention.preferences,
                // Merge array fields without duplicates
                requiredSkills: [...new Set([
                    ...(merged.intention.preferences.requiredSkills || []),
                    ...(newInfo.intention.preferences?.requiredSkills || [])
                ])],
                preferredIndustries: [...new Set([
                    ...(merged.intention.preferences.preferredIndustries || []),
                    ...(newInfo.intention.preferences?.preferredIndustries || [])
                ])],
                locationPreferences: [...new Set([
                    ...(merged.intention.preferences.locationPreferences || []),
                    ...(newInfo.intention.preferences?.locationPreferences || [])
                ])]
            }
        };
    }

    return merged;
}