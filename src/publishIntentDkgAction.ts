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
import { v4 as uuidv4 } from 'uuid';
import type { UUID } from 'crypto';
import type { UserProfileCache } from './professionalProfileEvaluator';

let DkgClient: any = null;

const KGExtractionTemplate = `
TASK: Transform extracted profile data into valid schema.org/FOAF compliant JSON-LD

Extracted Profile Data:
{{profile}}

Format response as array of public/private JSON-LD pairs:
[
  {
    "public": {
      "@context": ["http://schema.org", "http://xmlns.com/foaf/0.1/", {
        "datalatte": "http://datalatte.com/ns#"
      }],
      "@type": "Person",
      "@id": "urn:uuid:{{uuid}}",
      "datalatte:intention": {
        "@type": "datalatte:Intention",
        "datalatte:goalType": "{{intention.type}}",
        "description": "{{intention.description}}",
        "datalatte:preferences": {
          {{#with intention.preferences}}
          {{#if requiredSkills}} "seeks": ["{{#each requiredSkills}}"{{this}}"{{#unless @last}},{{/unless}}{{/each}}]" {{/if}}
          {{#if preferredIndustries}} "industryPreference": ["{{#each preferredIndustries}}"{{this}}"{{#unless @last}},{{/unless}}{{/each}}]" {{/if}}
          {{/with}}
        }
      }
    },
    "private": {
      "@context": ["http://schema.org", "http://xmlns.com/foaf/0.1/"],
      "@type": "Person",
      "@id": "urn:uuid:{{uuid}}",
      {{#with personal}}
        {{#if currentPosition}}
        "jobTitle": "{{currentPosition.title}}",
        "worksFor": {
          "@type": "Organization",
          "name": "{{currentPosition.company}}"
        },
        {{/if}}
        "skills": [
          {{#each skills}}"{{this}}"{{#unless @last}},{{/unless}}{{/each}}
        ],
        "homeLocation": [
          {{#each locations}}{
            "@type": "Place",
            "name": "{{this}}"
          }{{#unless @last}},{{/unless}}{{/each}}
        ]
      {{/with}},
      "account": {
        "@type": "OnlineAccount",
        "name": "{{onlineAccount.username}}",
        "identifier": {
          "@type": "PropertyValue",
          "propertyID": "{{onlineAccount.platform}}",
          "value": "{{onlineAccount.username}}"
        }
      }
    }
  }
]`;

export const publishIntentDkg: Action = {
    name: "PUBLISH_INTENT_DKG",
    similes: ["PUBLISH_TO_DKG", "SAVE_TO_DKG", "STORE_IN_DKG"],
    description: "Publishes professional profile and intent information to the OriginTrail Decentralized Knowledge Graph",
    
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

            // Try to get profile from state first
            let profile = state.currentProfile;
            
            // If not in state, try to get from cache
            if (!profile) {
                const username = state?.senderName || message.userId;
                const cacheKey = `${runtime.character.name}/${username}/data`;
                const cached = await runtime.cacheManager.get<UserProfileCache>(cacheKey);
                profile = cached?.data;
            }

            if (!profile) {
                elizaLogger.error("No profile found in state or cache");
                return false;
            }

            // Generate JSON-LD
            const context = composeContext({
                template: KGExtractionTemplate,
                state: {
                    ...state,
                    profile: JSON.stringify(profile, null, 2),
                    uuid: uuidv4() as UUID
                }
            });

            const jsonLdArray = await generateObjectArray({
                runtime,
                context,
                modelClass: ModelClass.LARGE
            });

            if (!jsonLdArray || jsonLdArray.length === 0) {
                elizaLogger.warn("Failed to generate JSON-LD for DKG");
                return false;
            }

            const { public: publicJsonLd, private: privateJsonLd } = jsonLdArray[0];

            elizaLogger.info("Generated JSON-LD for DKG:", {
                public: publicJsonLd,
                private: privateJsonLd
            });

            // Publish to DKG
            elizaLogger.info("Publishing profile to DKG with client config:", {
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
                elizaLogger.info("=== Personal Knowledge Asset Created ===");
                elizaLogger.info(`UAL: ${createAssetResult.UAL}`);
                elizaLogger.info(`DKG Explorer Link: ${runtime.getSetting("DKG_ENVIRONMENT") === 'mainnet' ?
                                'https://dkg.origintrail.io/explore?ual=' :
                                'https://dkg-testnet.origintrail.io/explore?ual='}${createAssetResult.UAL}`);
                elizaLogger.info("==========================================");

                callback({
                    text: `Successfully published your professional profile to DKG!\nView it here: ${runtime.getSetting("DKG_ENVIRONMENT") === 'mainnet' ?
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
            elizaLogger.error("Error in publishIntentDkg handler:", error);
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "publish my profile to dkg",
                    action: "PUBLISH_INTENT_DKG",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "Your profile has been published to DKG" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "save my profile to dkg", action: "PUBLISH_INTENT_DKG" },
            },
            {
                user: "{{user2}}",
                content: { text: "Profile saved successfully to DKG" },
            },
        ]
    ] as ActionExample[][],
} as Action; 