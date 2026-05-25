export const SENSITIVE_TOPIC_CATEGORIES = [
  {
    key: "finance_and_debt",
    label: "财务与负债",
    description: "收入稳定性、负债情况、消费习惯，以及金钱压力相关议题。"
  },
  {
    key: "family_boundaries",
    label: "家庭边界",
    description: "父母参与程度、婚后居住安排、家庭决策边界。"
  },
  {
    key: "marriage_and_housing_logistics",
    label: "婚姻与居住规划",
    description: "结婚节奏、住房安排、长期城市规划和现实预期。"
  },
  {
    key: "fertility_and_children",
    label: "生育与孩子",
    description: "是否要孩子、何时考虑孩子，以及相关态度。"
  },
  {
    key: "physical_and_mental_health",
    label: "身心健康",
    description: "重大身体或心理健康状况、治疗情况与健康规划。"
  },
  {
    key: "relationship_history",
    label: "情感经历",
    description: "过往重要关系、离异经历、重复出现的关系模式。"
  },
  {
    key: "lifestyle_and_risk_habits",
    label: "生活方式与风险习惯",
    description: "抽烟、饮酒、赌博、极端负债或高风险生活习惯。"
  }
];

export const RISK_RULES = [
  {
    code: "financial_solicitation",
    severity: "high",
    label: "金钱或投资试探",
    whyItMatters: "在关系早期就出现借钱、投资、转账等话题，往往是重要风险信号。",
    keywords: [
      "借钱",
      "转账",
      "投资",
      "理财",
      "币圈",
      "crypto",
      "loan",
      "borrow",
      "transfer",
      "帮我垫",
      "稳赚"
    ]
  },
  {
    code: "off_platform_redirect",
    severity: "medium",
    label: "快速导流到私域",
    whyItMatters: "过早把沟通导向其他平台，会降低留痕和可追溯性。",
    keywords: ["加微信", "私聊", "telegram", "whatsapp", "line", "wechat", "换个平台"]
  },
  {
    code: "rapid_intimacy",
    severity: "medium",
    label: "过快升温",
    whyItMatters: "情绪推进过快容易让人忽略真实匹配度和风险。",
    keywords: [
      "命中注定",
      "灵魂伴侣",
      "马上结婚",
      "立刻确定关系",
      "老婆",
      "老公",
      "soulmate",
      "destiny"
    ]
  },
  {
    code: "boundary_pressure",
    severity: "high",
    label: "边界施压",
    whyItMatters: "反感正常核实、抗拒提问或催促承诺，通常是强预警信号。",
    keywords: ["别问那么多", "你要相信我", "现在就答应", "不要告诉别人", "别核实", "不方便验证"]
  },
  {
    code: "risk_habits",
    severity: "medium",
    label: "高风险生活习惯",
    whyItMatters: "赌博、重度抽烟饮酒或极不稳定作息，可能是长期兼容性问题。",
    keywords: ["赌博", "赌", "抽烟", "酗酒", "通宵", "nightlife", "casino", "smoke heavily"]
  }
];

export const DIMENSION_DEFS = [
  { key: "relationshipGoal", label: "关系目标", weight: 24, sensitive: false },
  { key: "cityPlan", label: "城市与生活规划", weight: 10, sensitive: false },
  { key: "marriageTimeline", label: "结婚时间预期", weight: 14, sensitive: true },
  { key: "childrenPreference", label: "孩子与生育态度", weight: 14, sensitive: true },
  { key: "familyBoundary", label: "家庭边界", weight: 14, sensitive: true },
  { key: "financialView", label: "财务观", weight: 12, sensitive: true },
  { key: "communicationStyle", label: "沟通风格", weight: 12, sensitive: false }
];

export const PRIORITY_ORDER = ["high", "medium", "low"];
