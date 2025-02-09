import {
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    ModelClass,
    HandlerCallback,
    ActionExample,
    type Action,
    composeContext,
    generateObjectArray,
} from "@elizaos/core";
// @ts-ignore
import DKG from "dkg.js";
import type { UserIntentionCache } from './intentionProEvaluator';

let DkgClient: any = null;

// SPARQL query to find existing intentions for a user
const EXISTING_INTENTIONS_QUERY = `
PREFIX schema: <http://schema.org/>
PREFIX datalatte: <https://datalatte.com/ns/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>

SELECT DISTINCT ?intent ?description ?direction ?type ?preferences
WHERE {
    ?person a schema:Person ;
            foaf:account ?account .
    ?account a foaf:OnlineAccount ;
             foaf:accountServiceHomepage "{{platform}}" ;
             foaf:accountName "{{username}}" .
    ?person datalatte:hasIntent ?intent .
    ?intent a datalatte:proIntent ;
            schema:description ?description ;
            datalatte:intentDirection ?direction ;
            datalatte:intentType ?type .
    OPTIONAL {
        ?intent datalatte:hasPreferences ?preferences .
    }
}`;

const KGExtractionTemplate = `
TASK: Transform extracted intention data into valid schema.org/FOAF compliant JSON-LD, considering existing intentions

Intentions Data:
{{intentionsData}}

Existing Intentions in DKG:
{{existingIntentions}}

Guidelines:
1. If an intention with the same ID exists, only output fields that are new or updated
2. If no fields are new or updated, return an empty array
3. Use the existing intention IDs when updating
4. Maintain all existing relationships and properties not being updated

Format response as array of public/private JSON-LD pairs:
[
  {
    "public": {
      "@context": {
        "schema": "http://schema.org/",
        "datalatte": "https://datalatte.com/ns/"
      },
      "@type": "datalatte:proIntent",
      "@id": "urn:intent:{{intentid}}",
      "schema:description": "{{description}}",
      "datalatte:intentDirection": "{{direction}}",
      "datalatte:intentType": "{{type}}",
      "datalatte:hasPreferences": {
        "datalatte:requiredSkills": {{requiredSkills}},
        "datalatte:preferredIndustries": {{preferredIndustries}},
        "datalatte:experienceLevel": "{{experienceLevel}}",
        "datalatte:remotePreference": "{{remotePreference}}",
        "datalatte:contractType": "{{contractType}}",
        "datalatte:companySize": "{{companySize}}"
      }
    },
    "private": {
      "@context": {
        "schema": "http://schema.org/",
        "datalatte": "https://datalatte.com/ns/",
        "foaf": "http://xmlns.com/foaf/0.1/"
      },
      "@type": "schema:Person",
      "@id": "urn:uuid:{{uuid}}",
      "foaf:account": {
        "@type": "foaf:OnlineAccount",
        "foaf:accountServiceHomepage": "{{platform}}",
        "foaf:accountName": "{{username}}"
      },
      "datalatte:hasIntent": {
        "@type": "datalatte:proIntent",
        "@id": urn:intent:{{intentid}},
        "datalatte:budget": {
          "datalatte:amount": {{budget.amount}},
          "datalatte:currency": "{{budget.currency}}",
          "datalatte:frequency": "{{budget.frequency}}"
        },
        "datalatte:timeline": {
          "datalatte:startDate": "{{timeline.startDate}}",
          "datalatte:flexibility": "{{timeline.flexibility}}"
        },
        "datalatte:urgency": "{{urgency}}"
      }
    }
  }
]
- exclude any field from the output if results is null/empty
- if no new or updated fields, return []
`;

export const publishDkgIntentionProAction: Action = {
    name: "PUBLISH_DKG_INTENTION",
    similes: ["PUBLISH_INTENTION_TO_DKG", "SAVE_INTENTION_TO_DKG", "STORE_INTENTION_IN_DKG"],
    description: "Publishes professional intentions to the OriginTrail Decentralized Knowledge Graph",
    
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
            
            // Get platform type from client similar to profileProEvaluator
            const clients = runtime.clients;
            const client = Object.values(clients)[0];
            let platform = client?.constructor?.name?.replace('ClientInterface', '').toLowerCase();
            if (platform?.endsWith('client')) {
                platform = platform.replace('client', '');
            }

            elizaLogger.info("User platform details:", {
                username,
                platform,
                clientType: client?.constructor?.name
            });

            // First, check for existing intentions in DKG
            const existingIntentionsQuery = EXISTING_INTENTIONS_QUERY
                .replace("{{platform}}", platform)
                .replace("{{username}}", username);

            elizaLogger.info("Querying for existing intentions:", {
                query: existingIntentionsQuery
            });

            let existingIntentions;
            try {
                // Add a small delay to allow for DKG indexing if needed
                await new Promise(resolve => setTimeout(resolve, 5000));

                const queryResult = await DkgClient.graph.query(existingIntentionsQuery, "SELECT");
                elizaLogger.info("Existing intentions query result:", {
                    status: queryResult.status,
                    dataLength: queryResult.data?.length,
                    data: queryResult.data
                });

                existingIntentions = queryResult.data;
            } catch (error) {
                elizaLogger.error("Error querying existing intentions:", error);
                existingIntentions = [];
            }

            // Get intentions from cache
            const intentionCache = await runtime.cacheManager.get<UserIntentionCache>("intentions");
            const intentions = intentionCache?.intentions || [];

            if (intentions.length === 0) {
                elizaLogger.error("No intentions found in cache");
                return false;
            }

            // NOTE: Currently we're getting the latest intention (last in array) by default.
            // In future implementations, this intention ID will be fed from other functions
            // that specify which intention to publish. For now, we assume the user wants
            // to publish their most recent intention.
            const latestIntention = intentions[intentions.length - 1];
            
            elizaLogger.info("Retrieved data for DKG publishing", {
                intentionsCount: intentions.length,
                username,
                userId: message.userId,
                intentionId: latestIntention.id,
                platform,
                existingIntentionsCount: existingIntentions?.length || 0
            });

            if (!state) {
                state = await runtime.composeState(message);
            }

            // Add data to state including existing intentions
            state.intentionsData = JSON.stringify(latestIntention, null, 2);
            state.existingIntentions = JSON.stringify(existingIntentions || [], null, 2);
            state.uuid = message.userId;
            state.intentid = latestIntention.id;
            state.platform = platform;
            state.username = username;

            elizaLogger.info("Generating JSON-LD with context data:", {
                intentionsCount: intentions?.length || 0,
                userId: message.userId,
                platform,
                username,
                hasExistingIntentions: existingIntentions?.length > 0
            });

            const context = composeContext({
                template: KGExtractionTemplate,
                state
            });

            const jsonLdArray = await generateObjectArray({
                runtime,
                context,
                modelClass: ModelClass.LARGE
            });

            elizaLogger.info("Generation result:", {
                hasResult: !!jsonLdArray,
                arrayLength: jsonLdArray?.length || 0,
                firstItem: jsonLdArray?.[0] ? JSON.stringify(jsonLdArray[0]).substring(0, 200) + "..." : "no items"
            });

            // If no new or updated fields, don't publish
            if (!jsonLdArray || jsonLdArray.length === 0) {
                elizaLogger.info("No new or updated fields to publish");
                callback({
                    text: "Your intention is already up to date in the DKG. No changes needed!"
                });
                return true;
            }

            const { public: publicJsonLd, private: privateJsonLd } = jsonLdArray[0];

            elizaLogger.info("=== Generated JSON-LD for DKG ===");
            elizaLogger.info("Public JSON-LD:", {
                data: publicJsonLd
            });
            elizaLogger.info("Private JSON-LD:", {
                data: JSON.stringify(privateJsonLd, null, 2)
            });
            elizaLogger.info("================================");

            // Publish to DKG
            elizaLogger.info("Publishing to DKG with client config:", {
                environment: runtime.getSetting("DKG_ENVIRONMENT"),
                endpoint: runtime.getSetting("DKG_HOSTNAME"),
                port: runtime.getSetting("DKG_PORT"),
                blockchain: runtime.getSetting("DKG_BLOCKCHAIN_NAME")
            });

            let createAssetResult;
            try {
                elizaLogger.info("Initializing DKG asset creation...");

                createAssetResult = await DkgClient.asset.create(
                    {
                        public: publicJsonLd,
                        private: privateJsonLd
                    },
                    { epochsNum: 12 }
                );

                elizaLogger.info("DKG asset creation request completed successfully");
                elizaLogger.info("=== Knowledge Asset Created ===");
                elizaLogger.info(`UAL: ${createAssetResult.UAL}`);
                elizaLogger.info(`DKG Explorer Link: ${runtime.getSetting("DKG_ENVIRONMENT") === 'mainnet' ?
                                'https://dkg.origintrail.io/explore?ual=' :
                                'https://dkg-testnet.origintrail.io/explore?ual='}${createAssetResult.UAL}`);
                elizaLogger.info("===============================");

                callback({
                    text: `Successfully published your professional intentions to DKG!\nView it here: ${runtime.getSetting("DKG_ENVIRONMENT") === 'mainnet' ?
                          'https://dkg.origintrail.io/explore?ual=' :
                          'https://dkg-testnet.origintrail.io/explore?ual='}${createAssetResult.UAL}`
                });

                return true;

            } catch (error) {
                elizaLogger.error(
                    "Error occurred while publishing to DKG:",
                    error.message
                );

                if (error.stack) {
                    elizaLogger.error("Stack trace:", error.stack);
                }
                if (error.response) {
                    elizaLogger.error(
                        "Response data:",
                        JSON.stringify(error.response.data, null, 2)
                    );
                }
                return false;
            }

        } catch (error) {
            elizaLogger.error("Error in publishDkgIntention handler:", error);
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "publish my intentions to dkg",
                    action: "PUBLISH_DKG_INTENTION",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "Your intentions have been published to DKG" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "save my intentions to dkg", action: "PUBLISH_DKG_INTENTION" },
            },
            {
                user: "{{user2}}",
                content: { text: "Intentions saved successfully to DKG" },
            },
        ]
    ] as ActionExample[][],
} as Action; 