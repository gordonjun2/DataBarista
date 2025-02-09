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
import type { UserProfileCache } from './profileProEvaluator';

let DkgClient: any = null;

const KGExtractionTemplate = `
TASK: Transform extracted profile data into valid schema.org/FOAF compliant JSON-LD following the SHACL schema

Profile Data:
{{profileData}}

SHACL Schema for Validation:
{
  "@context": {
    "sh": "http://www.w3.org/ns/shacl#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
    "schema": "http://schema.org/",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "datalatte": "https://datalatte.com/ns/"
  },
  "@graph": [
    {
      "@id": "datalatte:ProProfileBaseShape",
      "@type": "sh:NodeShape",
      "sh:property": [
        {
          "sh:path": "schema:description",
          "sh:datatype": "xsd:string"
        }
      ]
    },
    {
      "@id": "datalatte:ProProfileShape",
      "@type": "sh:NodeShape",
      "sh:targetClass": ["schema:Person", "foaf:Person"],
      "sh:node": { "@id": "datalatte:ProProfileBaseShape" }
    }
  ]
}

Expected Output Format Example:
{
  "@context": {
    "schema": "http://schema.org/",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "datalatte": "https://datalatte.com/ns/"
  },
  "@id": "{{uuid}}",
  "@type": "schema:Person",
  "schema:description": "Experienced data scientist with over 10 years in industry.",
  "schema:hasOccupation": {
    "schema:jobTitle": "Senior Data Scientist",
    "datalatte:status": "employed",
    "schema:worksFor": {
      "schema:name": "Tech Solutions Inc.",
      "schema:industry": "Technology"
    },
    "schema:startDate": "2018-01-15"
  },
  "schema:knowsAbout": [
    {
      "schema:name": "Machine Learning",
      "datalatte:proficiency": "expert",
      "datalatte:years": 8
    }
  ],
  "schema:affiliation": "Data Science Association",
  "foaf:interest": "Advancing AI ethics",
  "datalatte:experienceLevel": "senior",
  "schema:event": [
    {
      "schema:name": "International Data Science Conference",
      "schema:startDate": "2024-11-10",
      "schema:location": "Berlin, Germany"
    }
  ],
  "schema:address": "123 Main St, Anytown, USA",
  "datalatte:willingToRelocate": false,
  "schema:alumniOf": {
    "schema:degree": "MSc Computer Science",
    "schema:fieldOfStudy": "Data Science",
    "schema:alumniOf": {
      "schema:name": "State University",
      "schema:industry": "Education"
    },
    "schema:startDate": "2010"
  },
  "schema:hasCredential": {
    "schema:name": "Certified Data Scientist",
    "datalatte:issuer": "Data Science Council",
    "schema:dateIssued": "2015",
    "schema:validThrough": "2025-12-31"
  },
  "schema:knowsLanguage": {
    "schema:name": "English",
    "datalatte:proficiency": "C2"
  },
  "datalatte:availability": {
    "datalatte:hoursPerWeek": 20,
    "datalatte:noticePeriod": "2 weeks"
  },
  "foaf:account": {
    "foaf:accountServiceHomepage": "https://linkedin.com/in/johndoe",
    "foaf:accountName": "johndoe"
  }
}

Format response as public/private JSON-LD pair:
{
  "public": {
    "@context": {
      "schema": "http://schema.org/",
      "foaf": "http://xmlns.com/foaf/0.1/",
      "datalatte": "https://datalatte.com/ns/"
    },
    "@id": "{{uuid}}",
    "@type": "schema:Person"
  },
  "private": {
    "@context": {
      "schema": "http://schema.org/",
      "foaf": "http://xmlns.com/foaf/0.1/",
      "datalatte": "https://datalatte.com/ns/"
    },
    "@id": "{{uuid}}",
    "@type": "schema:Person",
    "schema:description": "{{description}}",
    "schema:hasOccupation": {
      "schema:jobTitle": "{{currentPosition.title}}",
      "datalatte:status": "{{currentPosition.status}}",
      "schema:worksFor": {
        "schema:name": "{{currentPosition.company}}",
        "schema:industry": "{{currentPosition.industry}}"
      }
    },
    "schema:knowsAbout": {{skills}},
    "schema:affiliation": "{{affiliation}}",
    "datalatte:experienceLevel": "{{experienceLevel}}",
    "schema:address": "{{address}}",
    "schema:alumniOf": {{education}},
    "schema:hasCredential": {{certifications}},
    "schema:knowsLanguage": {{languages}},
    "datalatte:availability": {
      "datalatte:hoursPerWeek": {{availability.hoursPerWeek}},
      "datalatte:noticePeriod": "{{availability.noticePeriod}}"
    },
    "foaf:account": {
    "foaf:accountServiceHomepage": {{platformAccounts.platform}},
    "foaf:accountName": {{platformAccounts.username}}
    }
  }
}`;

export const publishDkgProfileProAction: Action = {
    name: "PUBLISH_DKG_PROFILE",
    similes: ["PUBLISH_PROFILE_TO_DKG", "SAVE_PROFILE_TO_DKG", "STORE_PROFILE_IN_DKG"],
    description: "Publishes professional profile to the OriginTrail Decentralized Knowledge Graph",
    
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

            // Get profile from cache
            const profileCache = await runtime.cacheManager.get<UserProfileCache>("profile");
            const profile = profileCache?.data;

            if (!profile) {
                elizaLogger.error("No profile found in cache");
                return false;
            }

            elizaLogger.info("Retrieved data for DKG publishing", {
                hasProfile: !!profile,
                username,
                userId: message.userId
            });

            if (!state) {
                state = await runtime.composeState(message);
            }

            // Add stringified data to state
            state.profileData = JSON.stringify(profile, null, 2);
            state.uuid = message.userId;

            elizaLogger.info("Generating JSON-LD with context data:", {
                hasProfile: !!profile,
                userId: message.userId
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

            if (!jsonLdArray || jsonLdArray.length === 0) {
                elizaLogger.warn("Failed to generate JSON-LD for DKG");
                return false;
            }

            const { public: publicJsonLd, private: privateJsonLd } = jsonLdArray[0];

            elizaLogger.info("=== Generated JSON-LD for DKG ===");
            elizaLogger.info("Public JSON-LD:", {
                data: JSON.stringify(publicJsonLd, null, 2)
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
            elizaLogger.error("Error in publishDkgProfile handler:", error);
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "publish my profile to dkg",
                    action: "PUBLISH_DKG_PROFILE",
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
                content: { text: "save my profile to dkg", action: "PUBLISH_DKG_PROFILE" },
            },
            {
                user: "{{user2}}",
                content: { text: "Profile saved successfully to DKG" },
            },
        ]
    ] as ActionExample[][],
} as Action; 