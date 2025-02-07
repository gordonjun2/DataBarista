import {
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    ModelClass,
    HandlerCallback,
    ActionExample,
    type Action,
} from "@elizaos/core";
// @ts-ignore
import DKG from "dkg.js";
//import type { UserProfileCache } from './professionalProfileEvaluator';

let DkgClient: any = null;

// SPARQL query to find a user's profile by their platform account
const USER_PROFILE_QUERY = `
SELECT DISTINCT ?person ?goalType ?description
WHERE {
    ?person a <http://schema.org/Person> ;
            <http://schema.org/account> ?account .
    ?account a <http://schema.org/OnlineAccount> ;
             <http://schema.org/identifier> ?identifier .
    ?identifier <http://schema.org/propertyID> "{{platform}}" ;
                <http://schema.org/value> "{{username}}" .
    ?person <http://datalatte.com/ns#intention> ?intention .
    ?intention <http://datalatte.com/ns#goalType> ?goalType ;
               <http://schema.org/description> ?description .
}
LIMIT 1`;

// SPARQL query to find matching profiles based on intention type
const MATCHING_PROFILES_QUERY = `
SELECT DISTINCT ?person ?goalType ?description ?skills ?industries
WHERE {
    ?person a <http://schema.org/Person> ;
            <http://datalatte.com/ns#intention> ?intention .
    ?intention <http://datalatte.com/ns#goalType> ?goalType ;
               <http://schema.org/description> ?description .
    
    OPTIONAL {
        ?intention <http://datalatte.com/ns#preferences> ?prefs .
        ?prefs <http://schema.org/seeks> ?skills ;
               <http://schema.org/industryPreference> ?industries .
    }
    
    FILTER(?goalType = "{{goalType}}")
    FILTER(?person != <{{userUri}}>)
}
LIMIT 10`;

export const serendipity: Action = {
    name: "SERENDIPITY",
    similes: ["FIND_MATCHES", "DISCOVER_CONNECTIONS", "SEARCH_SIMILAR_INTENTIONS"],
    description: "Searches the DKG for profiles with matching intentions and preferences",

    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const requiredEnvVars = [
            "DKG_ENVIRONMENT",
            "DKG_HOSTNAME",
            "DKG_PORT",
            "DKG_BLOCKCHAIN_NAME",
            "DKG_PUBLIC_KEY",
            "DKG_PRIVATE_KEY",
        ];

        const missingVars = requiredEnvVars.filter(
            (varName) => !runtime.getSetting(varName)
        );

        if (missingVars.length > 0) {
            elizaLogger.error(
                `Missing required environment variables: ${missingVars.join(", ")}`
            );
            return false;
        }

        return true;
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback
    ): Promise<boolean> => {
        try {
            // Initialize DKG client if needed
            if (!DkgClient) {
                DkgClient = new DKG({
                    environment: runtime.getSetting("DKG_ENVIRONMENT"),
                    endpoint: runtime.getSetting("DKG_HOSTNAME"),
                    port: runtime.getSetting("DKG_PORT"),
                    blockchain: {
                        name: runtime.getSetting("DKG_BLOCKCHAIN_NAME"),
                        publicKey: runtime.getSetting("DKG_PUBLIC_KEY"),
                        privateKey: runtime.getSetting("DKG_PRIVATE_KEY"),
                    },
                    maxNumberOfRetries: 300,
                    frequency: 2,
                    contentType: "all",
                    nodeApiVersion: "/v1",
                });
            }

            // Get username and platform type
            const username = state?.senderName || message.userId;
            const clients = runtime.clients;
            const client = Object.values(clients)[0];
            // Match the platform name with what we use in professionalProfileEvaluator
            let platform = client?.constructor?.name?.replace('ClientInterface', '').toLowerCase();
            if (platform?.endsWith('client')) {
                platform = platform.replace('client', '');
            }

            elizaLogger.info("User details from runtime:", {
                username,
                platform,
                clientType: client?.constructor?.name,
                originalPlatform: client?.constructor?.name?.replace('ClientInterface', '').toLowerCase()
            });

            if (!platform) {
                elizaLogger.error("Could not determine platform type from client");
                callback({
                    text: "I encountered an error while trying to find your profile. Please try again later."
                });
                return false;
            }

            // First, find the user's profile in DKG
            const userProfileQuery = USER_PROFILE_QUERY
                .replace("{{platform}}", platform)
                .replace("{{username}}", username);

            elizaLogger.info("Generated user profile query:", {
                query: userProfileQuery,
                platform,
                username
            });

            let userProfileResult;
            try {
                // Add a small delay to allow DKG indexing
                elizaLogger.info("Waiting for DKG indexing...");
                await new Promise(resolve => setTimeout(resolve, 5000));

                elizaLogger.info("Executing user profile query...");
                userProfileResult = await DkgClient.graph.query(userProfileQuery, "SELECT");
                elizaLogger.info("User profile query result:", {
                    status: userProfileResult.status,
                    dataLength: userProfileResult.data?.length,
                    data: userProfileResult.data
                });

                if (!userProfileResult.data?.length) {
                    elizaLogger.warn("No user profile found in DKG");
                    callback({
                        text: "I couldn't find your profile in the network yet. Please make sure you've published your profile using the 'publish to dkg' command and wait a few moments for it to be indexed."
                    });
                    return false;
                }

                const userProfile = userProfileResult.data[0];
                elizaLogger.info("Found user profile in DKG:", {
                    person: userProfile.person,
                    goalType: userProfile.goalType,
                    description: userProfile.description
                });

                const userUri = userProfile.person;
                const goalType = userProfile.goalType;

                // Now search for matching profiles
                const matchingProfilesQuery = MATCHING_PROFILES_QUERY
                    .replace("{{goalType}}", goalType)
                    .replace("{{userUri}}", userUri);

                elizaLogger.info("Generated matching profiles query:", {
                    query: matchingProfilesQuery
                });

                elizaLogger.info("Executing matching profiles query...");
                const matchingProfilesResult = await DkgClient.graph.query(matchingProfilesQuery, "SELECT");
                elizaLogger.info("Matching profiles query result:", {
                    status: matchingProfilesResult.status,
                    dataLength: matchingProfilesResult.data?.length,
                    data: matchingProfilesResult.data
                });

                if (!matchingProfilesResult.data?.length) {
                    elizaLogger.info("No matching profiles found");
                    callback({
                        text: "I couldn't find any matching profiles in the network yet. I'll keep looking!"
                    });
                    return true;
                }

                // Format results for display
                const matches = matchingProfilesResult.data.map((match: any) => ({
                    goalType: match.goalType,
                    description: match.description,
                    skills: match.skills,
                    industries: match.industries
                }));

                elizaLogger.info("Formatted matches:", {
                    matchCount: matches.length,
                    matches
                });

                const matchSummary = matches.map((match: any, index: number) => 
                    `Match ${index + 1}:\n` +
                    `Goal: ${match.goalType}\n` +
                    `Description: ${match.description}\n` +
                    (match.skills ? `Skills: ${match.skills.join(", ")}\n` : "") +
                    (match.industries ? `Industries: ${match.industries.join(", ")}` : "")
                ).join("\n\n");

                callback({
                    text: `I found ${matches.length} potential matches!\n\n${matchSummary}`
                });

                return true;

            } catch (error) {
                elizaLogger.error("Error executing SPARQL query:", {
                    error: error.message,
                    stack: error.stack,
                    response: error.response?.data
                });
                callback({
                    text: "I encountered an error while searching for matches. Please try again later."
                });
                return false;
            }

        } catch (error) {
            elizaLogger.error("Error in serendipity handler:", {
                error: error.message,
                stack: error.stack
            });
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "find me someone with similar interests",
                    action: "SERENDIPITY",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "I found several profiles that match your interests!" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "search for matching profiles", action: "SERENDIPITY" },
            },
            {
                user: "{{user2}}",
                content: { text: "Here are some profiles that align with your goals..." },
            },
        ]
    ] as ActionExample[][],
} as Action; 