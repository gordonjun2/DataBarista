import { Evaluator, IAgentRuntime, Memory, ModelClass, generateObjectArray, State, elizaLogger, composeContext } from "@elizaos/core";

// Types
interface UserIntention {
    id: string; // Unique identifier for the intention
    createdAt: number;
    lastUpdated: number;
    type: "mentorship" | "networking" | "collaboration" | "seeking_job"
        | "hiring" | "funding" | "startup_growth" | "skill_development"
        | "consulting" | "speaking_opportunity" | "project_partnership";
    direction: "seeking" | "offering";
    description: string;
    preferences: {
        requiredSkills?: string[];
        preferredSkills?: string[];
        preferredIndustries?: string[];
        avoidIndustries?: string[];
        experienceLevel?: "entry" | "mid" | "senior" | "executive";
        locationPreferences?: {
            country?: string[];
            region?: string[];
            timezone?: string[];
        };
        remotePreference?: "onsite" | "remote" | "hybrid";
        contractType?: "full-time" | "part-time" | "freelance" | "internship" | "contract";
        compensationRange?: {
            min: number;
            max: number;
            currency: string;
        };
        companySize?: "startup" | "small" | "medium" | "large";
        projectDuration?: "short-term" | "long-term";
    };
    budget?: {
        amount: number;
        currency: string;
        frequency?: "hourly" | "monthly" | "project-based";
    };
    timeline?: {
        startDate: string;
        flexibility: "fixed" | "flexible";
    };
    urgency?: "low" | "medium" | "high";
    status: "active" | "completed" | "paused"; // Track intention status
}

export interface UserIntentionCache {
    intentions: UserIntention[];
    lastUpdated: number;
    extractionState?: {
        currentIntentions: UserIntention[];
        conversationHistory: string[];
    };
}

// Constants
const INITIAL_INTENTIONS: UserIntention[] = [];

// Template focused on intentions and preferences with similarity detection
const extractionTemplate = `
TASK: Extract user's professional intentions and preferences from conversation history, and determine if this represents a new intention or updates an existing one.

Recent Messages:
{{recentMessages}}

Current Intentions:
{{currentIntentions}}

Format response as array of objects following this schema:
[{
    "analysis": {
        "isNewIntention": boolean, // Whether this represents a completely new intention
        "similarityToExisting": {
            "intentionId"?: string, // ID of most similar existing intention if any
            "similarityScore": number, // 0-1 score of similarity to existing intention
            "reason": string // Brief explanation of why this is new or similar
        }
    },
    "intention": {
        "type": "mentorship" | "networking" | "collaboration" | "seeking_job"
            | "hiring" | "funding" | "startup_growth" | "skill_development"
            | "consulting" | "speaking_opportunity" | "project_partnership",
        "direction": "seeking" | "offering",
        "description": string,
        "preferences": {
            "requiredSkills"?: string[],
            "preferredSkills"?: string[],
            "preferredIndustries"?: string[],
            "avoidIndustries"?: string[],
            "experienceLevel"?: "entry" | "mid" | "senior" | "executive",
            "locationPreferences"?: {
                "country"?: string[],
                "region"?: string[],
                "timezone"?: string[]
            },
            "remotePreference"?: "onsite" | "remote" | "hybrid",
            "contractType"?: "full-time" | "part-time" | "freelance" | "internship" | "contract",
            "compensationRange"?: {
                "min": number,
                "max": number,
                "currency": string
            },
            "companySize"?: "startup" | "small" | "medium" | "large",
            "projectDuration"?: "short-term" | "long-term"
        },
        "budget"?: {
            "amount": number,
            "currency": string,
            "frequency"?: "hourly" | "monthly" | "project-based"
        },
        "timeline"?: {
            "startDate": string,
            "flexibility": "fixed" | "flexible"
        },
        "urgency"?: "low" | "medium" | "high"
    }
}]

Rules:
1. Analyze if the extracted intention is new or updates an existing one
2. Consider an intention new if:
   - It has a different primary goal or purpose
   - It targets a significantly different outcome
   - It belongs to a different domain or context
3. Consider it an update if:
   - It refines or adds detail to an existing intention
   - It adjusts preferences for the same goal
   - It updates timeline/urgency for the same intention
4. Set similarityScore based on how closely it matches existing intentions
5. Provide clear reasoning for the decision

Example Response:
[{
    "analysis": {
        "isNewIntention": true,
        "similarityToExisting": {
            "similarityScore": 0,
            "reason": "New mentorship request with specific UX design focus"
        }
    },
    "intention": {
        "type": "mentorship",
        "direction": "seeking",
        "description": "Looking for a senior UX designer to review my portfolio",
        "preferences": {
            "requiredSkills": ["Figma", "User Research"],
            "preferredIndustries": ["Fintech", "Edtech"],
            "experienceLevel": "senior",
            "remotePreference": "remote",
            "projectDuration": "short-term"
        },
        "timeline": {
            "startDate": "2024-06-01",
            "flexibility": "fixed"
        },
        "urgency": "medium"
    }
}]

Output an empty array if no new information found: [{}]`;

export const intentionProEvaluator: Evaluator = {
    name: "intentionProEvaluator",
    description: "Evaluates messages that hints for user intentions as for professional goals and preferences. Choose the evaluator ONLY if user's latest message has any hints for user professional intentions",
    similes: ["EXTRACT_INTENTIONS", "GET_PREFERENCES", "ANALYZE_GOALS"],
    examples: [],
    
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
        elizaLogger.info("Starting intention evaluation validation", {
            messageId: message.id,
            userId: message.userId,
            source: message.content?.source,
            messageLength: message.content?.text?.length || 0,
            hasState: !!state
        });
        return true;
    },

    handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
        try {
            const username = state?.senderName || message.userId as string;
            
            elizaLogger.info("Starting intention extraction", {
                username,
                messageId: message.id,
                messageText: message.content?.text?.substring(0, 100) + "..."
            });

            // Get current intentions from cache
            const cache = runtime.cacheManager;
            const currentIntentionCache = await cache.get<UserIntentionCache>("intentions");
            
            const intentions = currentIntentionCache?.intentions || INITIAL_INTENTIONS;

            elizaLogger.info("Current intentions state", {
                hasExistingIntentions: intentions.length > 0,
                intentionCount: intentions.length,
                currentIntentions: intentions.map(i => ({
                    id: i.id,
                    type: i.type,
                    description: i.description?.substring(0, 50) + "...",
                    status: i.status,
                    lastUpdated: new Date(i.lastUpdated).toISOString()
                }))
            });

            if (!state) {
                state = await runtime.composeState(message);
            }
            
            state.currentIntentions = intentions;
            state = await runtime.updateRecentMessageState(state);

            // Extract intention information
            const context = composeContext({
                template: extractionTemplate,
                state
            });

            const extractedInfo = await generateObjectArray({
                runtime,
                context,
                modelClass: ModelClass.LARGE
            });

            if (extractedInfo && Array.isArray(extractedInfo)) {
                if (extractedInfo.length === 0 || (extractedInfo.length === 1 && Object.keys(extractedInfo[0]).length === 0)) {
                    elizaLogger.info("No new intention information found");
                    return false;
                }

                const newInfo = extractedInfo[0];
                elizaLogger.info("Extracted new intention info", {
                    analysis: newInfo.analysis,
                    intention: {
                        type: newInfo.intention.type,
                        description: newInfo.intention.description?.substring(0, 100) + "...",
                        preferences: newInfo.intention.preferences
                    }
                });

                const updatedIntentions = processNewIntention(intentions, newInfo);
                
                await cache.set("intentions", {
                    intentions: updatedIntentions,
                    lastUpdated: Date.now()
                });

                elizaLogger.info("Updated intentions state", {
                    totalIntentions: updatedIntentions.length,
                    latestIntention: {
                        id: updatedIntentions[updatedIntentions.length - 1].id,
                        type: updatedIntentions[updatedIntentions.length - 1].type,
                        status: updatedIntentions[updatedIntentions.length - 1].status
                    },
                    isNewIntention: newInfo.analysis?.isNewIntention
                });

                return true;
            }

            return false;
        } catch (error) {
            elizaLogger.error("Error in intention evaluator handler", {
                error: error.message,
                stack: error.stack
            });
            return false;
        }
    }
};

function processNewIntention(currentIntentions: UserIntention[], newInfo: any): UserIntention[] {
    if (!newInfo.intention || !newInfo.analysis) {
        return currentIntentions;
    }

    const now = Date.now();

    if (newInfo.analysis.isNewIntention) {
        // Create new intention
        const newIntention: UserIntention = {
            id: generateIntentionId(),
            createdAt: now,
            lastUpdated: now,
            status: "active",
            ...newInfo.intention
        };
        
        // Add new intention while keeping history
        return [...currentIntentions, newIntention];
    } else if (newInfo.analysis.similarityToExisting?.intentionId) {
        // Update existing intention
        return currentIntentions.map(intention => {
            if (intention.id === newInfo.analysis.similarityToExisting.intentionId) {
                return mergeIntentions(intention, newInfo.intention);
            }
            return intention;
        });
    }

    return currentIntentions;
}

function generateIntentionId(): string {
    return `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function mergeIntentions(current: UserIntention, newInfo: any): UserIntention {
    const merged = { ...current };

    // Update main intention fields
    merged.type = newInfo.type || merged.type;
    merged.description = newInfo.description || merged.description;
    merged.budget = newInfo.budget || merged.budget;
    merged.timeline = newInfo.timeline || merged.timeline;
    merged.urgency = newInfo.urgency || merged.urgency;
    merged.lastUpdated = Date.now();

    // Merge preferences
    if (newInfo.preferences) {
        merged.preferences = {
            ...merged.preferences,
            ...newInfo.preferences,
            // Merge arrays without duplicates
            requiredSkills: [...new Set([
                ...(merged.preferences.requiredSkills || []),
                ...(newInfo.preferences.requiredSkills || [])
            ])],
            preferredIndustries: [...new Set([
                ...(merged.preferences.preferredIndustries || []),
                ...(newInfo.preferences.preferredIndustries || [])
            ])],
            locationPreferences: {
                ...merged.preferences.locationPreferences,
                ...newInfo.preferences.locationPreferences
            }
        };
    }

    return merged;
} 