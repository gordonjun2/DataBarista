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
PREFIX schema: <http://schema.org/>
PREFIX datalatte: <https://datalatte.com/ns/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT ?userUri ?intentId ?intentType ?intentDirection ?intentDescription
WHERE {
    ?userUri rdf:type schema:Person ;
            foaf:account ?account .
    ?account a foaf:OnlineAccount ;
             foaf:accountServiceHomepage "{{platform}}" ;
             foaf:accountName "{{username}}" .
    ?userUri datalatte:hasIntent ?intentId .
    ?intentId rdf:type datalatte:intent ;
              datalatte:intentCategory "professional" ;
              schema:description ?intentDescription ;
              datalatte:intentDirection ?intentDirection ;
              datalatte:intentType ?intentType .
}
ORDER BY DESC(?intentId)
LIMIT 1`;  // Get only the latest intent

// SPARQL query to find matching profiles based on intention type with appropriate direction matching
const MATCHING_PROFILES_QUERY = `
PREFIX schema: <http://schema.org/>
PREFIX datalatte: <https://datalatte.com/ns/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT DISTINCT ?personUri ?intentId ?intentDescription ?intentDirection ?intentType
WHERE {
    ?personUri rdf:type schema:Person ;
              datalatte:hasIntent ?intentId .
    ?intentId rdf:type datalatte:intent ;
              datalatte:intentCategory "professional" ;
              schema:description ?intentDescription ;
              datalatte:intentDirection ?intentDirection ;
              datalatte:intentType ?intentType .
    
    # Match intention type - handle both quoted and unquoted values
    FILTER(REPLACE(str(?intentType), '"', '') = "networking")
    
    # Don't match with self
    FILTER(?personUri != <{{userUri}}>)
}
ORDER BY DESC(?intentId)
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

            const username = state?.senderName || message.userId;
            
            // Get platform type from client
            const clients = runtime.clients;
            const client = Object.values(clients)[0];
            let platform = client?.constructor?.name?.replace('ClientInterface', '').toLowerCase();
            if (platform?.endsWith('client')) {
                platform = platform.replace('client', '');
            }

            elizaLogger.info("User details from runtime:", {
                username,
                platform,
                clientType: client?.constructor?.name
            });

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
                // Add a small delay to allow for DKG indexing
                //elizaLogger.info("Waiting for DKG indexing...");
                //await new Promise(resolve => setTimeout(resolve, 5000));

                elizaLogger.info("Executing user profile query...");
                userProfileResult = await DkgClient.graph.query(userProfileQuery, "SELECT");
                elizaLogger.info("User profile query result:", {
                    status: userProfileResult.status,
                    data: userProfileResult.data
                });

                if (!userProfileResult.data || !userProfileResult.data.length) {
                    elizaLogger.warn("No user profile found in DKG");
                    callback({
                        text: "I couldn't find your profile in the network yet. Please make sure you've published your profile using the 'publish to dkg' command and wait a few moments for it to be indexed."
                    });
                    return false;
                }

                // Get the first (latest) result
                const latestResult = userProfileResult.data[0];
                const userUri = latestResult.userUri;
                const latestIntent = {
                    id: latestResult.intentId,
                    type: latestResult.intentType.replace(/^"|"$/g, ''),
                    direction: latestResult.intentDirection.replace(/^"|"$/g, ''),
                    description: latestResult.intentDescription.replace(/^"|"$/g, '')
                };

                elizaLogger.info("Found latest intent:", {
                    userUri,
                    latestIntent
                });

                if (!latestIntent || !userUri) {
                    elizaLogger.warn("No intent or user URI found", {
                        intentFound: !!latestIntent,
                        userUriFound: !!userUri,
                        rawData: JSON.stringify(userProfileResult.data)
                    });
                    callback({
                        text: "I couldn't find your profile information. Please try publishing your intention first."
                    });
                    return false;
                }

                // Now search for matching profiles using the latest intent
                const matchingProfilesQuery = MATCHING_PROFILES_QUERY
                    .replace("{{userUri}}", userUri);

                elizaLogger.info("Generated matching profiles query:", {
                    query: matchingProfilesQuery,
                    userUri
                });

                const matchingProfilesResult = await DkgClient.graph.query(matchingProfilesQuery, "SELECT");
                elizaLogger.info("Matching profiles query result:", {
                    status: matchingProfilesResult.status,
                    data: matchingProfilesResult.data
                });

                if (!matchingProfilesResult.data || !matchingProfilesResult.data.length) {
                    elizaLogger.info("No matching profiles found");
                    callback({
                        text: "I couldn't find any matching profiles in the network yet. I'll keep looking!"
                    });
                    return true;
                }

                // Format matches for display
                const matchSummary = matchingProfilesResult.data
                    .map((match, index) => 
                        `Match ${index + 1}:\n` +
                        `Direction: ${match.intentDirection.replace(/^"|"$/g, '')}${match.intentDirection.replace(/^"|"$/g, '') === "bidirectional" ? " (open to both seeking and offering)" : ""}\n` +
                        `Description: ${match.intentDescription.replace(/^"|"$/g, '')}`
                    ).join("\n\n");

                callback({
                    text: `I found ${matchingProfilesResult.data.length} potential matches!\n\n${matchSummary}`
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
                user: "DataBarista",
                content: {
                    text: "I just published your intent on DKG! You can view it here: https://dkg.origintrail.io/explore?ual={UAL}",
                    action: "SERENDIPITY",
                },
            },
            {
                user: "DataBarista",
                content: { text: "I found {{user2}} that match your interests! Would you like introductions?" },
            },
        ]
    ] as ActionExample[][],
} as Action; 