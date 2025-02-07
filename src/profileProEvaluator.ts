import { Evaluator, IAgentRuntime, Memory, ModelClass, generateObjectArray, State, elizaLogger, composeContext } from "@elizaos/core";

// Types
interface ProfessionalProfile {
    platformAccounts: Array<{
        platform: string;
        username: string;
    }>;
    personal: {
        summary?: string;
        currentPosition?: {
            title?: string;
            company?: string;
            industry?: string;
            startDate?: string; // YYYY-MM-DD
            status?: "actively-looking" | "employed" | "freelancing" | "founder" 
                    | "student" | "open-to-offers";
        };
        role?: string;
        skills?: Array<{
            name: string;
            proficiency?: "beginner" | "intermediate" | "expert";
            years?: number;
        }>;
        industries?: string[];
        interests?: string[];
        experienceLevel?: "entry" | "mid" | "senior" | "executive";
        eventsAttended?: Array<{
            name: string;
            date?: string;
            location?: string;
        }>;
        locations?: {
            current?: string;
            willingToRelocate?: boolean;
        };
        education?: Array<{
            degree?: string;
            field?: string;
            institution?: string;
            year?: number;
        }>;
        certifications?: Array<{
            name: string;
            issuer?: string;
            year?: number
        }>;
        languages?: Array<{
            name: string;
            proficiency?: "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
        }>;
        availability?: {
            hoursPerWeek?: number;
            noticePeriod?: string;
        };
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
        industries: []
    }
};

// Template focused on professional background
const extractionTemplate = `
TASK: Extract professional background and attributes from conversation history.

Recent Messages:
{{recentMessages}}

Current Profile:
{{currentProfile}}

Format response as array of objects following this schema:
[{
    "personal": {
        "summary"?: string, // Brief professional elevator pitch
        "currentPosition"?: {
            "title"?: string,
            "company"?: string,
            "industry"?: string,
            "startDate"?: string, // YYYY-MM-DD format
            "status"?: "actively-looking" | "employed" | "freelancing" | "founder" | "student" | "open-to-offers"
        },
        "skills"?: [{
            "name": string,
            "proficiency"?: "beginner" | "intermediate" | "expert",
            "years"?: number
        }],
        "industries"?: string[],
        "interests"?: string[], // Professional interests and focus areas
        "experienceLevel"?: "entry" | "mid" | "senior" | "executive",
        "eventsAttended"?: [{
            "name": string,
            "date"?: string, // YYYY-MM-DD format
            "location"?: string
        }],
        "locations"?: {
            "current"?: string,
            "willingToRelocate"?: boolean
        },
        "education"?: [{
            "degree"?: string,
            "field"?: string,
            "institution"?: string,
            "year"?: number
        }],
        "certifications"?: [{
            "name": string,
            "issuer"?: string,
            "year"?: number,
            "expiration"?: string // YYYY-MM-DD format
        }],
        "languages"?: [{
            "name": string,
            "proficiency"?: "A1" | "A2" | "B1" | "B2" | "C1" | "C2"
        }],
        "availability"?: {
            "hoursPerWeek"?: number,
            "noticePeriod"?: string
        }
    }
}]

Rules:
1. Extract current position from explicit statements ("I work at...", "Currently employed as...")
2. Derive status from context if not explicitly stated
3. Company names should be normalized to official names (e.g., "Google" not "big tech company")
4. Focus on extracting professional background information only
5. Include all relevant skills with proficiency levels and years of experience when mentioned
6. Use standardized language proficiency levels (A1-C2)
7. Convert all dates to YYYY-MM-DD format (including event dates)
8. Include availability information for freelancers/consultants
9. Track professional events attended with full details (conferences, workshops, etc.)
10. Capture professional interests distinct from skills or industries

Example Response:
[{
    "personal": {
        "summary": "Frontend developer with 4+ years in React & TypeScript",
        "currentPosition": {
            "title": "Software Engineer",
            "company": "Tech Corp",
            "industry": "SaaS",
            "status": "open-to-offers"
        },
        "skills": [
            { "name": "React", "proficiency": "expert", "years": 4 },
            { "name": "TypeScript", "proficiency": "intermediate", "years": 2 }
        ],
        "interests": ["Web3", "AI/ML", "Developer Experience"],
        "eventsAttended": [
            {
                "name": "React Conf 2023",
                "date": "2023-10-15",
                "location": "San Francisco, CA"
            }
        ],
        "experienceLevel": "mid"
    }
}]

Output an empty array if no new information found: [{}]`;

export const profileProEvaluator: Evaluator = {
    name: "profileProEvaluator",
    description: "Evaluates messages that reveals professional background information about the user. Choose this evaluator only if the latest message reveals professional background info",
    similes: ["EXTRACT_PROFESSIONAL_PROFILE", "GET_BACKGROUND", "ANALYZE_EXPERIENCE"],
    examples: [],
    
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
        elizaLogger.info("Starting profile evaluation validation", {
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
            const source = message.content?.source || "direct";
            
            elizaLogger.info("Starting profile extraction", {
                username,
                messageId: message.id,
                source,
                messageText: message.content?.text?.substring(0, 100) + "..."
            });

            // Get current profile from cache
            const cache = runtime.cacheManager;
            const currentProfile = await cache.get<UserProfileCache>("profile");
            
            const profile = currentProfile?.data || INITIAL_PROFILE;

            elizaLogger.info("Current profile state", {
                hasExistingProfile: !!currentProfile,
                lastUpdated: currentProfile?.lastUpdated ? new Date(currentProfile.lastUpdated).toISOString() : 'never',
                currentProfile: {
                    platformAccounts: profile.platformAccounts,
                    personal: {
                        currentPosition: profile.personal.currentPosition,
                        experienceLevel: profile.personal.experienceLevel,
                        skillsCount: profile.personal.skills?.length || 0,
                        industriesCount: profile.personal.industries?.length || 0,
                        certificationsCount: profile.personal.certifications?.length || 0,
                        educationCount: profile.personal.education?.length || 0
                    }
                }
            });

            if (!state) {
                state = await runtime.composeState(message);
            }
            
            state.currentProfile = profile;
            state = await runtime.updateRecentMessageState(state);

            // Handle platform account
            if (profile.platformAccounts.length === 0) {
                elizaLogger.info("Adding new platform account", {
                    platform: source,
                    username
                });
                profile.platformAccounts.push({
                    platform: source,
                    username
                });
            }

            // Extract profile information
            const context = composeContext({
                template: extractionTemplate,
                state
            });

            elizaLogger.info("Generating extraction with context", {
                templateLength: extractionTemplate.length,
                stateSize: JSON.stringify(state).length,
                recentMessagesCount: state.recentMessages?.length || 0
            });

            const extractedInfo = await generateObjectArray({
                runtime,
                context,
                modelClass: ModelClass.LARGE
            });

            if (extractedInfo && Array.isArray(extractedInfo)) {
                if (extractedInfo.length === 0 || (extractedInfo.length === 1 && Object.keys(extractedInfo[0]).length === 0)) {
                    elizaLogger.info("No new profile information found");
                    return false;
                }

                const newInfo = extractedInfo[0];
                elizaLogger.info("Extracted new profile info", {
                    personal: {
                        currentPosition: newInfo.personal?.currentPosition,
                        newSkills: newInfo.personal?.skills,
                        newIndustries: newInfo.personal?.industries,
                        newCertifications: newInfo.personal?.certifications,
                        newEducation: newInfo.personal?.education,
                        experienceLevel: newInfo.personal?.experienceLevel
                    }
                });

                const updatedProfile = mergeProfiles(profile, newInfo);
                
                elizaLogger.info("Profile changes detected", {
                    username,
                    changes: {
                        currentPositionUpdated: !!newInfo.personal?.currentPosition,
                        skillsAdded: (newInfo.personal?.skills || []).length,
                        industriesAdded: (newInfo.personal?.industries || []).length,
                        certificationsAdded: (newInfo.personal?.certifications || []).length,
                        educationAdded: (newInfo.personal?.education || []).length,
                        experienceLevelChanged: profile.personal.experienceLevel !== updatedProfile.personal.experienceLevel
                    },
                    updatedTotals: {
                        skills: updatedProfile.personal.skills?.length || 0,
                        industries: updatedProfile.personal.industries?.length || 0,
                        certifications: updatedProfile.personal.certifications?.length || 0,
                        education: updatedProfile.personal.education?.length || 0
                    }
                });

                await cache.set("profile", {
                    data: updatedProfile,
                    lastUpdated: Date.now()
                });

                return true;
            }

            return false;
        } catch (error) {
            elizaLogger.error("Error in profile evaluator handler", {
                error: error.message,
                stack: error.stack
            });
            return false;
        }
    }
};

function mergeProfiles(current: ProfessionalProfile, newInfo: any): ProfessionalProfile {
    const merged = { ...current };

    // Merge personal information
    if (newInfo.personal) {
        merged.personal = {
            ...merged.personal,
            // Update summary if provided
            summary: newInfo.personal.summary || merged.personal.summary,
            // Update current position
            currentPosition: newInfo.personal.currentPosition || merged.personal.currentPosition,
            // Update experience level
            experienceLevel: newInfo.personal.experienceLevel || merged.personal.experienceLevel,
            // Update locations
            locations: newInfo.personal.locations || merged.personal.locations,
            // Update availability
            availability: newInfo.personal.availability || merged.personal.availability,
            // Merge arrays with unique entries
            industries: [...new Set([...(merged.personal.industries || []), ...(newInfo.personal.industries || [])])],
            interests: [...new Set([...(merged.personal.interests || []), ...(newInfo.personal.interests || [])])],
            // Merge complex arrays
            skills: mergeSkills(merged.personal.skills || [], newInfo.personal.skills || []),
            education: mergeEducation(merged.personal.education || [], newInfo.personal.education || []),
            certifications: mergeCertifications(merged.personal.certifications || [], newInfo.personal.certifications || []),
            languages: mergeLanguages(merged.personal.languages || [], newInfo.personal.languages || []),
            eventsAttended: mergeEvents(merged.personal.eventsAttended || [], newInfo.personal.eventsAttended || [])
        };
    }

    return merged;
}

function mergeSkills(current: any[], newSkills: any[]): any[] {
    const skillMap = new Map();
    
    // Add current skills to map
    current.forEach(skill => {
        skillMap.set(skill.name, skill);
    });
    
    // Update or add new skills
    newSkills.forEach(skill => {
        if (skillMap.has(skill.name)) {
            const existingSkill = skillMap.get(skill.name);
            skillMap.set(skill.name, {
                ...existingSkill,
                ...skill,
                years: Math.max(existingSkill.years || 0, skill.years || 0)
            });
        } else {
            skillMap.set(skill.name, skill);
        }
    });
    
    return Array.from(skillMap.values());
}

function mergeEducation(current: any[], newEducation: any[]): any[] {
    const eduMap = new Map();
    
    // Create unique key for education entries
    const getEduKey = (edu: any) => 
        `${edu.degree || ''}-${edu.field || ''}-${edu.institution || ''}-${edu.year || ''}`;
    
    current.forEach(edu => {
        eduMap.set(getEduKey(edu), edu);
    });
    
    newEducation.forEach(edu => {
        const key = getEduKey(edu);
        if (!eduMap.has(key)) {
            eduMap.set(key, edu);
        }
    });
    
    return Array.from(eduMap.values());
}

function mergeCertifications(current: any[], newCerts: any[]): any[] {
    const certMap = new Map();
    
    // Create unique key for certification entries
    const getCertKey = (cert: any) => 
        `${cert.name || ''}-${cert.issuer || ''}-${cert.year || ''}`;
    
    current.forEach(cert => {
        certMap.set(getCertKey(cert), cert);
    });
    
    newCerts.forEach(cert => {
        const key = getCertKey(cert);
        if (!certMap.has(key)) {
            certMap.set(key, cert);
        }
    });
    
    return Array.from(certMap.values());
}

function mergeLanguages(current: any[], newLangs: any[]): any[] {
    const langMap = new Map();
    
    current.forEach(lang => {
        langMap.set(lang.name, lang);
    });
    
    newLangs.forEach(lang => {
        if (langMap.has(lang.name)) {
            const existingLang = langMap.get(lang.name);
            langMap.set(lang.name, {
                ...existingLang,
                ...lang
            });
        } else {
            langMap.set(lang.name, lang);
        }
    });
    
    return Array.from(langMap.values());
}

function mergeEvents(current: any[], newEvents: any[]): any[] {
    const eventMap = new Map();
    
    // Create unique key for event entries
    const getEventKey = (event: any) => 
        `${event.name || ''}-${event.date || ''}-${event.location || ''}`;
    
    current.forEach(event => {
        eventMap.set(getEventKey(event), event);
    });
    
    newEvents.forEach(event => {
        const key = getEventKey(event);
        if (!eventMap.has(key)) {
            eventMap.set(key, event);
        }
    });
    
    return Array.from(eventMap.values());
} 