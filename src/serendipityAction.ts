import {
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    ModelClass,
    ActionExample,
    type Action,
    composeContext,
    generateObjectArray,
  } from "@elizaos/core";
  // @ts-ignore
  import DKG from "dkg.js";
  
  let DkgClient: any = null;
  
  const USER_PROFILE_QUERY = `
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
  }
  `;
  
  //
  // New Match-Prompt Template: Generate a concise social media post
  // based on the candidate profiles and user profile. The prompt instructs
  // the LLM to choose the best match and output just the text post.
  //
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
  Generate a concise, friendly social media post (in a modern Twitter/X style) that introduces this best match to the user.
  The post should:
  1. Use the proper @usernames for both parties
  2. Highlight key synergies in their backgrounds and projects
  3. Mention how they might help solve each other's challenges
  4. Put into consideration that users might know each other already, so see if the profiles are too close and mention same project names, or other things hinting they work at same place, do not choose the candidate as match.
  
  Output Format:
  Return an array containing a single object with the following structure:
  [{
    "post": "Generated social media post text here"
  }]
  
  Example Output:
  [{
    "post": "🤝 Exciting match! @exampleuser1 meet @exampleuser2! Both revolutionizing data ownership in their unique ways. user1's human-computer interfaces + user2's data privacy work = perfect synergy for democratizing personal data. Let's brew some innovation! 🚀"
  }]
  
  Do not include any additional text or explanation outside of the array structure.
  `;
  
  interface SparqlQuery {
    query: string;
  }
  
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
  
  export const serendipity: Action = {
    name: "SERENDIPITY",
    similes: ["FIND_MATCHES", "DISCOVER_CONNECTIONS"],
    description: "Finds optimal matches using DKG data and AI analysis",
  
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
      const requiredVars = ["DKG_ENVIRONMENT", "DKG_HOSTNAME", "DKG_PORT"];
      return requiredVars.every(v => runtime.getSetting(v));
    },
  
    handler: async (runtime, message, state, _, callback) => {
      try {
        if (!DkgClient) {
          DkgClient = new DKG({
            environment: runtime.getSetting("DKG_ENVIRONMENT"),
            endpoint: runtime.getSetting("DKG_HOSTNAME"),
            port: runtime.getSetting("DKG_PORT"),
            blockchain: {
              name: runtime.getSetting("DKG_BLOCKCHAIN_NAME"),
              publicKey: runtime.getSetting("DKG_PUBLIC_KEY"),
              privateKey: runtime.getSetting("DKG_PRIVATE_KEY"),
            }
          });
        }
  
        const username = state?.senderName || message.userId;
        const client = Object.values(runtime.clients)[0];
        const platform = client?.constructor?.name?.replace(/ClientInterface|client/gi, '').toLowerCase();
  
        elizaLogger.info("=== Serendipity Action Started ===");
        elizaLogger.info("User Context:", { username, platform });
  
        // Get user profile.
        const profileQuery = USER_PROFILE_QUERY
          .replace("{{platform}}", platform)
          .replace("{{username}}", username);
  
        elizaLogger.info("=== User Profile Query ===");
        elizaLogger.info(profileQuery);
        elizaLogger.info("=========================");
  
        const profileResult = await DkgClient.graph.query(profileQuery, "SELECT");
        elizaLogger.info("=== User Profile Result ===");
        elizaLogger.info(JSON.stringify(profileResult.data?.[0] || {}, null, 2));
        elizaLogger.info("==========================");
  
        if (!profileResult.data?.length) {
          callback({ text: "Please publish your profile first using 'publish to dkg'" });
          return false;
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
          callback({ text: "Your profile seems incomplete. Please make sure to specify your knowledge domain, project domain, and desired connections when publishing to DKG." });
          return false;
        }
  
        const candidates = await getMatchingProfiles(runtime, userProfile, platform, username);
        if (!candidates.length) {
          callback({ text: "No matches found yet. I'll keep searching!" });
          return true;
        }
  
        // Prepare LLM context for generating a social media post.
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
  
        // Generate the post text from the candidate profiles.
        const postResult = await generateObjectArray({
          runtime,
          context,
          modelClass: ModelClass.LARGE
        });
  
        if (!postResult?.length) {
          callback({ text: "Found matches but couldn't generate the post. Please try again later!" });
          return true;
        }
  
        // Extract the post text from the result array
        const postMessage = postResult[0]?.post || "Found matches but couldn't format the message properly. Please try again!";
  
        callback({ text: postMessage });
        return true;
  
      } catch (error) {
        elizaLogger.error("Serendipity error", error);
        callback({ text: "Matchmaking system busy. Please try again later!" });
        return false;
      }
    },
  
    examples: [
      [{
        user: "DataBarista",
        content: {
          text: "Searching for professionals in web3 marketing...",
          action: "SERENDIPITY"
        }
      }],
      [{
        user: "User",
        content: { text: "Find me blockchain developers" }
      }]
    ] as ActionExample[][]
  } as Action;
  