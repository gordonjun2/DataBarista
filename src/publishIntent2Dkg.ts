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

let DkgClient: any = null;

// SPARQL query to find existing professional intentions for a user
const EXISTING_INTENTIONS_QUERY = `
PREFIX schema:    <http://schema.org/>
PREFIX datalatte: <https://datalatte.com/ns/>
PREFIX foaf:      <http://xmlns.com/foaf/0.1/>
PREFIX rdf:       <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT ?person ?name ?background ?knowledgeDomain ?privateDetails ?personTimestamp
       ?latestIntent ?intentTimestamp ?summary ?allDesiredConnections ?projDesc ?challenge ?url ?relatedProject
       ?latestProject ?projectTimestamp ?projectName ?projectDescriptionFull ?projectType ?projectDomain ?projectTechStack
WHERE {
  # Person info
  {
    SELECT ?person 
           (MAX(?pTs) AS ?personTimestamp)
           (MAX(?nameVal) AS ?name)
           (MAX(?bg) AS ?background)
           (MAX(?kd) AS ?knowledgeDomain)
           (MAX(?pd) AS ?privateDetails)
    WHERE {
      ?person rdf:type foaf:Person ;
              foaf:account ?account .
      ?account a foaf:OnlineAccount ;
               foaf:accountServiceHomepage "{{platform}}" ;
               foaf:accountName "{{username}}" .
      OPTIONAL { ?person foaf:name ?nameVal. }
      OPTIONAL { ?person datalatte:background ?bg. }
      OPTIONAL { ?person datalatte:knowledgeDomain ?kd. }
      OPTIONAL { ?person datalatte:privateDetails ?pd. }
      OPTIONAL { ?person datalatte:revisionTimestamp ?pTs. }
    }
    GROUP BY ?person
  }
  
  # Latest Intent Timestamp per person
  OPTIONAL {
    SELECT ?person (MAX(?it) AS ?intentTimestamp)
    WHERE {
      ?person datalatte:hasIntent ?i .
      ?i rdf:type datalatte:Intent ;
         datalatte:intentCategory "professional" ;
         datalatte:revisionTimestamp ?it .
    }
    GROUP BY ?person
  }
  
  # Latest Intent details joined on that timestamp
  OPTIONAL {
    ?person datalatte:hasIntent ?latestIntent .
    ?latestIntent rdf:type datalatte:Intent ;
                  datalatte:intentCategory "professional" ;
                  datalatte:revisionTimestamp ?intentTimestamp . 
    OPTIONAL { ?latestIntent datalatte:summary ?summary. }
    OPTIONAL { ?latestIntent datalatte:projectDescription ?projDesc. }
    OPTIONAL { ?latestIntent datalatte:challenge ?challenge. }
    OPTIONAL { ?latestIntent schema:url ?url. }
    OPTIONAL { ?latestIntent datalatte:relatedTo ?relatedProject. }
    OPTIONAL { ?latestIntent datalatte:desiredConnections ?allDesiredConnections }
  }
  
  
  # Latest Project Timestamp per person
  OPTIONAL {
    SELECT ?person (MAX(?pt) AS ?projectTimestamp)
    WHERE {
      ?person datalatte:hasProject ?p .
      ?p rdf:type datalatte:Project ;
         datalatte:revisionTimestamp ?pt .
    }
    GROUP BY ?person
  }
  
  # Latest Project details joined on that timestamp
  OPTIONAL {
    ?person datalatte:hasProject ?latestProject .
    ?latestProject rdf:type datalatte:Project ;
                   datalatte:revisionTimestamp ?projectTimestamp ;
                   foaf:name ?projectName ;
                   schema:description ?projectDescriptionFull ;
                   datalatte:type ?projectType ;
                   datalatte:domain ?projectDomain .
    OPTIONAL { ?latestProject datalatte:techStack ?projectTechStack. }
  }
}`;

const MATCH_PROMPT_TEMPLATE = `
MATCHMAKING SOCIAL POST GENERATION TASK

User Profile:
- Username: @{{username}}
- Knowledge Domain: {{userKnowledgeDomain}}
- Project Domain: {{userProjectDomain}}
- Desired Connections: {{userDesiredConnections}}
- Project: {{userProjectName}}
- Project Description: {{userProjectDesc}}
- Background: {{userBackground}}
- Challenge: {{userChallenge}}

Candidate Profiles:
{{#each candidates}}
[Candidate {{@index}}]
- Username: @{{this.username}}
- Expertise: {{this.knowledgeDomain}}
- Background: {{this.background}}
- Project Type: {{this.projectType}}
- Project Name: {{this.projectName}}
- Project Description: {{this.projectDescription}}
- Challenge: {{this.challenge}}
- Desired Connections: {{this.desiredConnections}}
{{/each}}

Task:
From the above candidate profiles, choose the best match that aligns with the user's interests.
Generate a friendly social media post that introduces the user and the best match together.
The post should:
1. Use the proper @username for both user and the best match chosen
2. Highlight their synergy and how they might help solve each other
3. Do not use hashtags
4. Post 500 characters or less
  
  
  Return an array containing a single object with the following structure:

  Example Output:
  [{
    "post": "🤝 Exciting match! @user_username meet @match_username! Both revolutionizing data ownership in their unique ways. @user_username's human-computer interfaces + match_username's data privacy work = perfect synergy for democratizing personal data. Let's brew some innovation!"
  }]
  
  Do not include any additional text or explanation outside of the array structure.
`;

async function generateMatchingQuery(
  runtime: IAgentRuntime,
  userProfile: any,
  platform: string,
  username: string
): Promise<string> {
  const context = `
You are a SPARQL query generator. Your task is to output a JSON array containing one object with a single property "query" whose value is a valid SPARQL query string.
Do not output any additional text or explanation.

User Profile:
- Knowledge Domain: ${userProfile.knowledgeDomain}
- Project Domain: ${userProfile.projectDomain}
- Desired Connections: ${userProfile.desiredConnections}
- Project Description: ${userProfile.projDesc || ""}
- Challenge: ${userProfile.challenge || ""}

Task:
Generate a SPARQL query that finds matching profiles in the Decentralized Knowledge Graph (DKG) using dynamic filtering.
The query should:
1. Exclude the user's own profile (platform: "${platform}", username: "${username}").
2. Dynamically derive filtering keywords from the user's profile.
3. Look for candidates where any of the following fields (using OPTIONAL patterns) contain the keywords (case-insensitive): 
    - datalatte:knowledgeDomain
    - datalatte:background
    - datalatte:desiredConnections (bind as ?allDesiredConnections)
    - datalatte:domain from the related project.
4. Use COALESCE to default missing values to an empty string in the FILTER.
5. Order results by the most recent intent timestamp.
6. Limit the results to 15.

Ensure the SELECT clause includes:
  ?person, ?name, ?knowledgeDomain, ?background, ?allDesiredConnections, ?projectDomain, ?projectType, ?challenge, ?intentTimestamp, ?projectName, and ?projectDescription

Example Output:
[{
  "query": "PREFIX schema: <http://schema.org/> PREFIX datalatte: <https://datalatte.com/ns/> PREFIX foaf: <http://xmlns.com/foaf/0.1/> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> SELECT DISTINCT ?person ?name ?knowledgeDomain ?background ?allDesiredConnections ?projectDomain ?projectType ?challenge ?intentTimestamp ?projectName ?projectDescription WHERE { { SELECT ?person (MAX(?ts) AS ?intentTimestamp) { ?person datalatte:hasIntent/datalatte:revisionTimestamp ?ts . } GROUP BY ?person } ?person a foaf:Person ; foaf:name ?name . OPTIONAL { ?person datalatte:knowledgeDomain ?knowledgeDomain. } OPTIONAL { ?person datalatte:background ?background. } OPTIONAL { ?person datalatte:hasIntent ?intent. } OPTIONAL { ?intent datalatte:desiredConnections ?allDesiredConnections ; datalatte:challenge ?challenge ; datalatte:relatedTo ?project . OPTIONAL { ?project datalatte:type ?projectType. } OPTIONAL { ?project datalatte:domain ?projectDomain. } OPTIONAL { ?project foaf:name ?projectName. } OPTIONAL { ?project schema:description ?projectDescription. } } FILTER NOT EXISTS { ?person foaf:account [ foaf:accountServiceHomepage \\"${platform}\\"; foaf:accountName \\"${username}\\" ] } FILTER ( CONTAINS(LCASE(COALESCE(STR(?knowledgeDomain), \\"\\")), \\"${userProfile.knowledgeDomain.toLowerCase()}\\" ) || CONTAINS(LCASE(COALESCE(STR(?background), \\"\\")), \\"${userProfile.knowledgeDomain.toLowerCase()}\\" ) || CONTAINS(LCASE(COALESCE(STR(?allDesiredConnections), \\"\\")), \\"${userProfile.desiredConnections.toLowerCase()}\\" ) || CONTAINS(LCASE(COALESCE(STR(?projectDomain), \\"\\")), \\"${userProfile.projectDomain.toLowerCase()}\\" ) ) } ORDER BY DESC(?intentTimestamp) LIMIT 15"
}]
`;

  const queryResult = await generateObjectArray({
    runtime,
    context,
    modelClass: ModelClass.LARGE
  });

  if (!queryResult?.length) {
    throw new Error("Failed to generate SPARQL query");
  }

  elizaLogger.info("Generated Query Output:", queryResult);
  return queryResult[0].query;
}

async function getMatchingProfiles(
  runtime: IAgentRuntime,
  userProfile: any,
  platform: string,
  username: string
) {
  elizaLogger.info("=== Serendipity Matching Query Parameters ===");
  elizaLogger.info("User Profile:", {
    knowledgeDomain: userProfile.knowledgeDomain,
    projectDomain: userProfile.projectDomain,
    desiredConnections: userProfile.desiredConnections,
    platform,
    username,
  });

  const sparqlQuery = await generateMatchingQuery(runtime, userProfile, platform, username);

  elizaLogger.info("=== Serendipity Search Query ===");
  elizaLogger.info(sparqlQuery);
  elizaLogger.info("=================================");

  try {
    const result = await DkgClient.graph.query(sparqlQuery, "SELECT");
    elizaLogger.info("=== Serendipity Search Results ===");
    elizaLogger.info(`Found ${result.data?.length || 0} potential matches`);
    if (result.data?.length > 0) {
      result.data.forEach((match: any, index: number) => {
        elizaLogger.info(`Match ${index + 1}:`, {
          name: match.name?.replace(/^"|"$/g, ''),
          knowledgeDomain: match.knowledgeDomain?.replace(/^"|"$/g, ''),
          desiredConnections: match.allDesiredConnections?.replace(/^"|"$/g, ''),
          projectType: match.projectType?.replace(/^"|"$/g, ''),
          projectDomain: match.projectDomain?.replace(/^"|"$/g, ''),
          challenge: match.challenge?.replace(/^"|"$/g, '')
        });
      });
    }
    elizaLogger.info("================================");

    if (!result.data) return [];

    return result.data.map((candidate: any) => ({
      ...candidate,
      name: candidate.name?.replace(/^"|"$/g, ''),
      knowledgeDomain: candidate.knowledgeDomain?.replace(/^"|"$/g, ''),
      desiredConnections: candidate.allDesiredConnections?.replace(/^"|"$/g, ''),
      projectType: candidate.projectType?.replace(/^"|"$/g, ''),
      projectDomain: candidate.projectDomain?.replace(/^"|"$/g, ''),
      challenge: candidate.challenge?.replace(/^"|"$/g, ''),
      projectName: candidate.projectName?.replace(/^"|"$/g, ''),
      projectDescription: candidate.projectDescription?.replace(/^"|"$/g, '')
    }));
  } catch (error) {
    elizaLogger.error("=== Serendipity Search Error ===");
    elizaLogger.error("SPARQL query failed:", error);
    elizaLogger.error("=============================");
    return [];
  }
}

const KGExtractionTemplate = `
TASK: Transform conversation data into valid schema.org/FOAF compliant JSON-LD for professional intentions, considering existing intentions in DKG

Recent Messages:
{{recentMessages}}

Existing knowledge related to the person:
{{existingIntentions}}


SHACL Shapes for Validation:
@prefix sh:       <http://www.w3.org/ns/shacl#> .
@prefix xsd:      <http://www.w3.org/2001/XMLSchema#> .
@prefix schema:   <http://schema.org/> .
@prefix foaf:     <http://xmlns.com/foaf/0.1/> .
@prefix datalatte:<https://datalatte.com/ns/> .

#############################
# Person Shape (Private)
#############################
# We use foaf:Person as the target class. Additional private properties (background,
# domain, privateDetails) and relationships to intents and projects are modeled using
# custom properties in the datalatte namespace.
datalatte:PersonShape
  a sh:NodeShape ;
  sh:targetClass foaf:Person ;
  
  # Revision timestamp
  sh:property [
      sh:path datalatte:revisionTimestamp ;
      sh:datatype xsd:dateTime ;
      sh:minCount 1 ;
      sh:description "Timestamp of when this node was last revised." ;
  ] ;
  
  # hasAccount: expects an embedded account node
  sh:property [
      sh:path datalatte:hasAccount ;
      sh:node datalatte:AccountShape ;
      sh:minCount 1 ;
      sh:description "The account information including platform and username." ;
  ] ;
  
  # Optional name (using foaf:name)
  sh:property [
      sh:path foaf:name ;
      sh:datatype xsd:string ;
      sh:minCount 0 ;
      sh:description "The person's name (optional)." ;
  ] ;
  
  # Background: a private biography or context
  sh:property [
      sh:path datalatte:background ;
      sh:datatype xsd:string ;
      sh:minCount 1 ;
      sh:description "Private biography or context (e.g., 'Founder of an AI analytics startup')." ;
  ] ;
  
  # Domain: primary field (e.g., Web3, DeFi, NFT)
  sh:property [
      sh:path datalatte:domain ;
      sh:datatype xsd:string ;
      sh:minCount 1 ;
      sh:description "Primary field (e.g., Web3, DeFi, NFT)." ;
  ] ;
  
  # Private details: any additional personal/sensitive data
  sh:property [
      sh:path datalatte:privateDetails ;
      sh:datatype xsd:string ;
      sh:minCount 0 ;
      sh:description "Additional personal or sensitive details (private)." ;
  ] ;
  
  # Relationship to a public (anonymized) Intent
  sh:property [
      sh:path datalatte:hasIntent ;
      sh:class datalatte:Intent ;
      sh:minCount 0 ;
      sh:description "Link to the public, anonymized intent node." ;
  ] ;
  
  # Relationship to a private Project
  sh:property [
      sh:path datalatte:hasProject ;
      sh:class datalatte:Project ;
      sh:minCount 0 ;
      sh:description "Link to private project details." ;
  ] .

#############################
# Account Shape (for hasAccount)
#############################
# Models the account object attached to a Person. This shape requires a platform and username.
datalatte:AccountShape
  a sh:NodeShape ;
  sh:property [
    sh:path datalatte:platform ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "Platform of the account (e.g., Twitter, GitHub)." ;
  ] ;
  sh:property [
    sh:path datalatte:username ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "Username on the given platform." ;
  ] .

#############################
# Intent Shape (Public & Anonymized)
#############################
# An Intent node captures the public matchmaking request. It is linked to a Project
# (using the relatedTo property) and contains a summary, desired connections,
# public project description, and a challenge summary.
datalatte:IntentShape
  a sh:NodeShape ;
  sh:targetClass datalatte:Intent ;
  
  # Revision timestamp
  sh:property [
    sh:path datalatte:revisionTimestamp ;
    sh:datatype xsd:dateTime ;
    sh:minCount 1 ;
    sh:description "Timestamp of when this intent was last revised." ;
  ] ;
  
  sh:property [
    sh:path datalatte:summary ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "An anonymized summary of what the user seeks (e.g., 'Seeking a marketing expert to scale digital outreach')." ;
  ] ;
  sh:property [
    sh:path datalatte:desiredConnections ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "A list or category of experts or partners the user wants to meet." ;
  ] ;
  sh:property [
    sh:path datalatte:projectDescription ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "A public version of the project description (anonymized)." ;
  ] ;
  sh:property [
    sh:path datalatte:challenge ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "A summary of the challenge or goal that the user is facing." ;
  ] ;
  sh:property [
    sh:path datalatte:relatedTo ;
    sh:class datalatte:Project ;
    sh:minCount 0 ;
    sh:description "Links the intent to a private project node." ;
  ] .

#############################
# Project Shape (Private)
#############################
# A Project node contains details about the user's project. It includes a title,
# description, classification type, domain, and technical details.
datalatte:ProjectShape
  a sh:NodeShape ;
  sh:targetClass datalatte:Project ;
  
  # Revision timestamp
  sh:property [
    sh:path datalatte:revisionTimestamp ;
    sh:datatype xsd:dateTime ;
    sh:minCount 1 ;
    sh:description "Timestamp of when this project was last revised." ;
  ] ;
  
  sh:property [
    sh:path foaf:name ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "Project title or name (e.g., 'NFT Art Marketplace')." ;
  ] ;
  sh:property [
    sh:path schema:description ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "A summary of what the project is about." ;
  ] ;
  sh:property [
    sh:path datalatte:type ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "Classification of the project (e.g., marketplace, protocol, DAO tool, game, platform)." ;
  ] ;
  sh:property [
    sh:path datalatte:domain ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "Domain of the project (e.g., Web3, blockchain, metaverse)." ;
  ] ;
  sh:property [
    sh:path datalatte:techStack ;
    sh:datatype xsd:string ;
    sh:minCount 0 ;
    sh:description "Technical details or technology stack used in the project." ;
  ] .



Guidelines:
1. First analyze if the intent and project from conversation matches or updates any existing intention and project:
   - If exact match exists (same core intention, no new details) -> return empty array
   - If similar intent/project exists but has new details -> use existing intention/project ID and merge details
   - If completely new intention/project -> use the provided new ID
2. For existing updates:
   - Keep all existing fields in the output
   - Add or update fields that have new information
   - Use the exact ID from the matching existing knowledge asset
3. For new intents and projects:
   - Use the provided new ID
   - Fill all fields that can be extracted from conversation
4. All fields must match their defined datatypes and value constraints

Format response as array:
[
  {
    "analysis": {
      "matchType": "exact_match" | "update_existing" | "new_information",
      "existingIntentionId": "<id of matching intention if update_existing>",
      "existingProjectId": "<id of matching project if update_existing>",
      "reason": "<explanation of the decision>"
    },
    "public": {
      "@context": {
        "schema": "http://schema.org/",
        "datalatte": "https://datalatte.com/ns/"
      },
      "@type": "datalatte:Intent",
      "@id": "urn:intent:{{intentid}}",
      "datalatte:revisionTimestamp": "{{timestamp}}",
      "datalatte:summary": "<Anonymized summary of what the user seeks, e.g., 'Seeking a marketing expert to scale digital outreach'>",
      "datalatte:desiredConnections": [
        "<expertise type1>",
        "<expertise type2>"
      ],
      "datalatte:projectDescription": "<Public description of the project, anonymized>",
      "datalatte:challenge": "<Summary of the challenge or goal user seeks>",
      "schema:url": "<Extracted URL if mentioned>",
      "datalatte:intentCategory": "professional",
      "datalatte:relatedTo": "urn:project:{{projectid}}"
    },
    "private": {
      "@context": {
        "schema": "http://schema.org/",
        "datalatte": "https://datalatte.com/ns/",
        "foaf": "http://xmlns.com/foaf/0.1/"
      },
      "@type": "foaf:Person",
      "@id": "urn:uuid:{{uuid}}",
      "datalatte:revisionTimestamp": "{{timestamp}}",
      "foaf:account": {
        "@type": "foaf:OnlineAccount",
        "foaf:accountServiceHomepage": "{{platform}}",
        "foaf:accountName": "{{username}}"
      },
      "datalatte:background": "<Private biography or contextual background (e.g., 'Founder of an AI analytics startup')>",
      "datalatte:knowledgeDomain": "<Primary field, e.g., 'Web3', 'DeFi', 'NFT'>",
      "datalatte:privateDetails": "<Any additional sensitive details>",
      "datalatte:hasIntent": {
        "@type": "datalatte:Intent",
        "@id": "urn:intent:{{intentid}}",
      },
      "datalatte:hasProject": {
        "@type": "datalatte:Project",
        "@id": "urn:project:{{projectid}}",
        "datalatte:revisionTimestamp": "{{timestamp}}",
        "foaf:name": "<Project title, e.g., 'NFT Art Marketplace'>",
        "schema:description": "<Project description summary>",
        "datalatte:type": "<Classification, e.g., 'marketplace', 'protocol', 'DAO tool', 'game', 'platform'>",
        "datalatte:domain": "<Project domain, e.g., 'Web3', 'blockchain', 'metaverse'>",
        "datalatte:techStack": "<Technical details or technology stack used>"
      }
    }
  }
]

- If nothing new is found or conversation does not reveal any information that can be extracted in this template, return []
- If updating existing intent or project, use that intention's ID instead of {{intentid}} as well as existing project's ID instead of {{projectid}}
- Exclude any field from the output if not found in conversation
`;

export const publishIntent2Dkg: Action = {
  name: "PUBLISH_DKG_INTENT",
  similes: ["PUBLISH_INTENTION_TO_DKG", "SAVE_INTENTION_TO_DKG", "STORE_INTENTION_IN_DKG"],
  description: "Publishes intents to the DKG",

  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const requiredEnvVars = [
      "DKG_ENVIRONMENT",
      "DKG_HOSTNAME",
      "DKG_PORT",
      "DKG_BLOCKCHAIN_NAME",
      "DKG_PUBLIC_KEY",
      "DKG_PRIVATE_KEY",
    ];

    const missingVars = requiredEnvVars.filter((varName) => !runtime.getSetting(varName));

    if (missingVars.length > 0) {
      elizaLogger.error(`Missing required environment variables: ${missingVars.join(", ")}`);
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
      let platform = client?.constructor?.name?.replace("ClientInterface", "").toLowerCase();
      if (platform?.endsWith("client")) {
        platform = platform.replace("client", "");
      }

      elizaLogger.info("User platform details:", {
        username,
        platform,
        clientType: client?.constructor?.name,
      });

      // First, check for existing professional intentions in DKG
      const existingIntentionsQuery = EXISTING_INTENTIONS_QUERY.replace("{{platform}}", platform).replace(
        "{{username}}",
        username
      );

      elizaLogger.info("Querying for existing professional intentions:", {
        query: existingIntentionsQuery,
      });

      let existingIntentions;
      //existingIntentions = [];      //not doing any query for now
      try {
        // Add a small delay to allow for DKG indexing if needed
        // await new Promise((resolve) => setTimeout(resolve, 5000));

         const queryResult = await DkgClient.graph.query(existingIntentionsQuery, "SELECT");
         elizaLogger.info("Existing intentions query result:", {
           status: queryResult.status,
           dataLength: queryResult.data?.length,
           data: queryResult.data,
         });

        existingIntentions = queryResult.data;
      } catch (error) {
        elizaLogger.error("Error querying existing intentions:", error);
        existingIntentions = [];
      }

      // Update state with recent messages and existing intentions
      if (!state) {
        state = await runtime.composeState(message);
      }
      state = await runtime.updateRecentMessageState(state);

      // Generate a new intention ID that will only be used if needed
      const newIntentionId = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const newProjectId = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      state.intentid = newIntentionId; // This may be replaced by an existing ID
      state.projectid = newProjectId; // This may be replaced by an existing ID
      state.uuid = message.userId;
      state.platform = platform;
      state.username = username;
      state.timestamp = new Date().toISOString(); // Add current timestamp in ISO format
      state.existingIntentions = JSON.stringify(existingIntentions || [], null, 2);

      elizaLogger.info("Generating JSON-LD with context data:", {
        messageId: message.id,
        platform,
        username,
        newIntentionId,
        newProjectId
      });

      const context = composeContext({
        template: KGExtractionTemplate,
        state,
      });

      elizaLogger.info("=== Full KG Extraction Template Prompt ===");
      elizaLogger.info("Template:", {
        fullPrompt: context,
        stateData: {
          recentMessages: state.recentMessages,
          uuid: state.uuid,
          intentid: state.intentid,
          projectid: state.projectid,
          platform: state.platform,
          username: state.username,
        },
      });
      elizaLogger.info("=====================================");

      const result = await generateObjectArray({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
      });

      if (!result || result.length === 0) {
        elizaLogger.info("No professional intention to publish - empty result");
        callback({
          text: "I found that this professional intention is already published in the DKG. No changes needed!",
        });
        return true;
      }

      const firstResult = result[0];
      const analysis = firstResult.analysis;
      elizaLogger.info("Professional intention analysis:", analysis);

      if (analysis.matchType === "exact_match") {
        elizaLogger.info("Exact match found - no updates needed");
        callback({
          text: "I found that this professional intention is already published in the DKG. No changes needed!",
        });
        return true;
      }

      // If it's an update to an existing intention, use that ID
      if (analysis.matchType === "update_existing" && analysis.existingIntentionId) {
        state.intentid = analysis.existingIntentionId;
        elizaLogger.info("Updating existing professional intention:", {
          existingId: analysis.existingIntentionId,
          reason: analysis.reason,
        });
      }

      const { public: publicJsonLd, private: privateJsonLd } = firstResult;

      elizaLogger.info("=== Generated JSON-LD for DKG ===");
      elizaLogger.info("Public JSON-LD:", {
        data: publicJsonLd,
      });
      elizaLogger.info("Private JSON-LD:", {
        data: JSON.stringify(privateJsonLd, null, 2),
      });
      elizaLogger.info("================================");

      // Publish to DKG
      elizaLogger.info("Publishing professional intention to DKG with client config:", {
        environment: runtime.getSetting("DKG_ENVIRONMENT"),
        endpoint: runtime.getSetting("DKG_HOSTNAME"),
        port: runtime.getSetting("DKG_PORT"),
        blockchain: runtime.getSetting("DKG_BLOCKCHAIN_NAME"),
      });

      let createAssetResult;
      try {
        elizaLogger.info("Initializing DKG asset creation...");

        createAssetResult = await DkgClient.asset.create(
          {
            public: publicJsonLd,
            private: privateJsonLd,
          },
          { epochsNum: 3 } // keeping this intention in the DKG for 3 months only
        );

        elizaLogger.info("DKG asset creation request completed successfully");
        elizaLogger.info("=== Knowledge Asset Created ===");
        elizaLogger.info(`UAL: ${createAssetResult.UAL}`);
        elizaLogger.info(
          `DKG Explorer Link: ${
            runtime.getSetting("DKG_ENVIRONMENT") === "mainnet"
              ? "https://dkg.origintrail.io/explore?ual="
              : "https://dkg-testnet.origintrail.io/explore?ual="
          }${createAssetResult.UAL}`
        );
        elizaLogger.info("===============================");

        // Send the first callback for successful publishing
        callback({
          text: `Here's your anonymous intent on DKG: ${
            runtime.getSetting("DKG_ENVIRONMENT") === "mainnet"
              ? "https://dkg.origintrail.io/explore?ual="
              : "https://dkg-testnet.origintrail.io/explore?ual="
            }${createAssetResult.UAL}. Feel free adding detail while i am checking my network for your match.`,
        });

        // Add a delay to allow DKG indexing
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Query for the user's profile including the newly published intent
        const profileQuery = EXISTING_INTENTIONS_QUERY
          .replace("{{platform}}", platform)
          .replace("{{username}}", username);

        elizaLogger.info("=== User Profile Query After Publishing ===");
        elizaLogger.info(profileQuery);
        elizaLogger.info("=========================================");

        const profileResult = await DkgClient.graph.query(profileQuery, "SELECT");
        elizaLogger.info("=== User Profile Result After Publishing ===");
        elizaLogger.info(JSON.stringify(profileResult.data?.[0] || {}, null, 2));
        elizaLogger.info("==========================================");

        if (!profileResult.data?.length) {
          return true; // Already published successfully, so return true even if matching fails
        }

        const rawProfile = profileResult.data[0];
        const userProfile = {
          knowledgeDomain: rawProfile.knowledgeDomain?.replace(/^"|"$/g, ''),
          projectDomain: rawProfile.projectDomain?.replace(/^"|"$/g, ''),
          desiredConnections: rawProfile.allDesiredConnections?.replace(/^"|"$/g, ''),
          intent: rawProfile.latestIntent,
          challenge: rawProfile.challenge?.replace(/^"|"$/g, ''),
          projDesc: rawProfile.projDesc?.replace(/^"|"$/g, '')
        };

        if (!userProfile.knowledgeDomain || !userProfile.projectDomain || !userProfile.desiredConnections) {
          return true; // Already published successfully, so return true even if matching fails
        }

        const candidates = await getMatchingProfiles(runtime, userProfile, platform, username);
        if (!candidates.length) {
          callback({ text: "No matches found yet. I'll keep searching!" });
          return true;
        }

        // Prepare LLM context for generating a social media post
        if (!state) {
          state = await runtime.composeState(message);
        }
        state = {
          ...state,
          username: username,
          userKnowledgeDomain: userProfile.knowledgeDomain,
          userProjectDomain: userProfile.projectDomain,
          userDesiredConnections: userProfile.desiredConnections,
          userProjectName: rawProfile.projectName?.replace(/^"|"$/g, ''),
          userProjectDesc: userProfile.projDesc,
          userBackground: rawProfile.background?.replace(/^"|"$/g, ''),
          userChallenge: userProfile.challenge,
          candidates: candidates.map(c => ({
            ...c,
            username: c.username || c.name?.toLowerCase().replace(/\s+/g, '') || 'user',
            knowledgeDomain: c.knowledgeDomain?.replace(/^"|"$/g, ''),
            background: c.background?.replace(/^"|"$/g, ''),
            projectName: c.projectName?.replace(/^"|"$/g, ''),
            projectDescription: c.projectDescription?.replace(/^"|"$/g, ''),
            challenge: c.challenge?.replace(/^"|"$/g, ''),
            desiredConnections: c.desiredConnections?.replace(/^"|"$/g, '')
          }))
        };

        const context = composeContext({
          template: MATCH_PROMPT_TEMPLATE,
          state
        });

        // Generate the post text from the candidate profiles
        const postResult = await generateObjectArray({
          runtime,
          context,
          modelClass: ModelClass.LARGE
        });

        if (!postResult?.length) {
          callback({ text: "Found matches but couldn't generate the post. Please try again later!" });
          return true;
        }

        // Extract the post text from the result array and send the second callback
        const postMessage = postResult[0]?.post || "Found matches but couldn't format the message properly. Please try again!";
        callback({ text: postMessage });

        return true;
      } catch (error) {
        elizaLogger.error("Error occurred while publishing professional intention to DKG:", error.message);
        if (error.stack) {
          elizaLogger.error("Stack trace:", error.stack);
        }
        if (error.response) {
          elizaLogger.error("Response data:", JSON.stringify(error.response.data, null, 2));
        }
        return false;
      }
    } catch (error) {
      elizaLogger.error("Error in publishIntent2Dkg handler:", error);
      return false;
    }
  },

  examples: [
    [
      {
        user: "DataBarista",
        content: {
          "text": "Great, I'll post an introduction and tag both you and a growth specialist from my network as soon as I find a match! Wish to add any additional details?",
          "action": "(PUBLISH_DKG_INTENT)"
        },
      }
    ],
    [
      {
        "user": "DataBarista",
        "content": {
          "text": "Great, I'll post an introduction and tag both you and a crowdfunding expert from my network as soon as I find a match! Wish to add any additional details? (PUBLISH_DKG_INTENT)",
          "action": "(PUBLISH_DKG_INTENT)"
        }
      },
      {
        "user": "{{user2}}",
        "content": {
          "text": "Yeah it would be great if they had previous experience in blockchain and crypto."
        }
      },
      {
        "user": "DataBarista",
        "content": {
          "text": "Gotcha adding it to your brew.",
          "action": "(PUBLISH_DKG_INTENT)"
        }
      }
    ]
  ] as ActionExample[][],
} as Action;
