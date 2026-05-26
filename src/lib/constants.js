export const SENSITIVE_TOPIC_CATEGORIES = [
  {
    key: "finance_and_debt",
    label: "财务与负债",
    description: "收入稳定性、负债情况、消费习惯，以及和金钱压力相关的话题。"
  },
  {
    key: "family_boundaries",
    label: "家庭边界",
    description: "父母参与程度、婚后居住安排，以及家庭决策边界。"
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
    label: "感情经历",
    description: "过去重要关系、离异经历、重复出现的关系模式。"
  },
  {
    key: "lifestyle_and_risk_habits",
    label: "生活方式与风险习惯",
    description: "抽烟、喝酒、赌博、极端负债或高风险生活习惯。"
  }
];

export const DIMENSION_DEFS = [
  { key: "relationshipGoal", label: "关系目标", weight: 22, sensitive: false },
  { key: "cityPlan", label: "城市与生活规划", weight: 10, sensitive: false },
  { key: "marriageTimeline", label: "结婚时间预期", weight: 14, sensitive: true },
  { key: "childrenPreference", label: "孩子与生育态度", weight: 14, sensitive: true },
  { key: "familyBoundary", label: "家庭边界", weight: 14, sensitive: true },
  { key: "financialView", label: "财务观", weight: 12, sensitive: true },
  { key: "communicationStyle", label: "沟通风格", weight: 14, sensitive: false }
];

export const PRIORITY_ORDER = ["high", "medium", "low"];

export const PRIORITY_LABELS = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级"
};

export const STATUS_LABELS = {
  aligned: "高度一致",
  mixed: "部分一致",
  unclear: "待确认",
  conflict: "明显冲突"
};

export const REPORT_BAND_LABELS = {
  strong: "优先进入下一阶段",
  promising: "值得继续观察",
  "needs-clarification": "先补齐信息再决定",
  weak: "当前不优先",
  hold: "暂不推进"
};

export const VALUE_LABELS = {
  relationshipGoal: {
    serious: "认真长期 / 以结婚为目标",
    exploratory: "先了解看看 / 节奏较轻",
    unknown: "未明确"
  },
  marriageTimeline: {
    within_1_year: "希望 1 年内推进",
    one_to_two_years: "希望 1 到 2 年内推进",
    open_ended: "节奏开放 / 暂不着急",
    unknown: "未明确"
  },
  childrenPreference: {
    wants_children: "希望未来要孩子",
    no_children: "明确不要孩子",
    open: "开放 / 暂未决定",
    unknown: "未明确"
  },
  familyBoundary: {
    independent: "偏独立小家庭",
    family_led: "父母参与度较高",
    unknown: "未明确"
  },
  financialView: {
    practical: "偏务实稳定",
    status_spending: "偏高消费或面子驱动",
    unknown: "未明确"
  },
  communicationStyle: {
    direct: "直接清晰",
    steady: "稳定持续",
    slow_burn: "慢热 / 低频推进",
    unknown: "未明确"
  }
};

export const CANDIDATE_RISK_DEFS = {
  family_led: {
    label: "家庭参与度高",
    severity: "medium",
    severityLabel: "中风险",
    whyItMatters: "婚后边界可能更依赖原生家庭，适合在下一阶段重点核实。"
  },
  status_spending: {
    label: "消费观偏激进",
    severity: "medium",
    severityLabel: "中风险",
    whyItMatters: "如果用户偏好务实稳定，这类差异可能会在长期关系里被放大。"
  },
  exploratory_goal: {
    label: "关系目标偏轻",
    severity: "high",
    severityLabel: "高风险",
    whyItMatters: "候选人更偏探索或随缘，不适合强长期导向用户优先推进。"
  },
  low_verification: {
    label: "认证程度偏低",
    severity: "medium",
    severityLabel: "中风险",
    whyItMatters: "基础认证不足意味着真实性和信任度还需要更多验证。"
  },
  high_mobility: {
    label: "异地迁移成本高",
    severity: "medium",
    severityLabel: "中风险",
    whyItMatters: "城市与生活安排可能需要较大调整，进入下一阶段前应确认现实可行性。"
  },
  childfree_conflict: {
    label: "生育态度潜在冲突",
    severity: "high",
    severityLabel: "高风险",
    whyItMatters: "如果用户有明确生育计划，这会成为优先级很高的冲突点。"
  }
};

export const REALITY_PREFERENCE_MODES = [
  { key: "ignore", label: "不纳入匹配" },
  { key: "prefer", label: "加分偏好" },
  { key: "require", label: "必须满足" },
  { key: "reject", label: "不接受" }
];

export const REALITY_MODE_LABELS = Object.fromEntries(
  REALITY_PREFERENCE_MODES.map((mode) => [mode.key, mode.label])
);

export const REALITY_FIELD_DEFS = [
  {
    key: "incomeBand",
    label: "税前月收入区间",
    optional: true,
    supportsMultiValue: true,
    suggestionReason: "有助于系统判断双方对现实生活成本和推进节奏的适配度。",
    options: [
      { value: "undisclosed", label: "暂不披露" },
      { value: "below_15k", label: "1.5 万以下" },
      { value: "15k_to_30k", label: "1.5 万到 3 万" },
      { value: "30k_to_50k", label: "3 万到 5 万" },
      { value: "50k_plus", label: "5 万以上" }
    ]
  },
  {
    key: "incomeStability",
    label: "收入 / 工作稳定性",
    optional: true,
    supportsMultiValue: true,
    suggestionReason: "有助于系统评估现实可推进性和压力承受能力。",
    options: [
      { value: "stable", label: "稳定" },
      { value: "variable", label: "波动较大" },
      { value: "currently_adjusting", label: "当前处于调整期" }
    ]
  },
  {
    key: "debtLevel",
    label: "负债压力",
    optional: true,
    supportsMultiValue: true,
    suggestionReason: "有助于系统判断财务观和中长期生活压力的匹配度。",
    options: [
      { value: "none_or_low", label: "几乎没有或压力较低" },
      { value: "mortgage_or_car_loan_only", label: "主要是房贷 / 车贷" },
      { value: "manageable_consumer_debt", label: "有可控的消费负债" },
      { value: "high_pressure", label: "负债压力较高" }
    ]
  },
  {
    key: "housingStatus",
    label: "住房状态",
    optional: true,
    supportsMultiValue: true,
    suggestionReason: "有助于系统判断居住独立性和婚后落地难度。",
    options: [
      { value: "renting_independently", label: "独立租房" },
      { value: "own_with_loan", label: "有房有贷" },
      { value: "own_without_loan", label: "有房无贷" },
      { value: "living_with_parents", label: "目前与父母同住" },
      { value: "not_fixed", label: "居住状态未固定" }
    ]
  },
  {
    key: "vehicleStatus",
    label: "车辆状态",
    optional: true,
    supportsMultiValue: true,
    suggestionReason: "有助于系统判断通勤方式和部分现实生活便利程度。",
    options: [
      { value: "none", label: "无车" },
      { value: "own", label: "有车" },
      { value: "shared_family_vehicle", label: "家庭共用车辆" }
    ]
  },
  {
    key: "siblingStructure",
    label: "兄弟姐妹结构",
    optional: true,
    supportsMultiValue: true,
    suggestionReason: "有助于系统判断家庭责任分布和未来照护压力。",
    options: [
      { value: "only_child", label: "独生子女" },
      { value: "has_siblings", label: "有兄弟姐妹" }
    ]
  },
  {
    key: "parentCareBurden",
    label: "父母照护压力",
    optional: true,
    supportsMultiValue: true,
    suggestionReason: "有助于系统判断家庭责任与婚后生活边界的现实影响。",
    options: [
      { value: "low", label: "较低" },
      { value: "medium", label: "中等" },
      { value: "high", label: "较高" }
    ]
  },
  {
    key: "postMaritalLivingPreference",
    label: "婚后居住 / 同住取向",
    optional: true,
    supportsMultiValue: true,
    suggestionReason: "有助于系统判断婚后生活方式与家庭边界的匹配度。",
    options: [
      { value: "independent_home", label: "希望独立小家庭" },
      { value: "near_parents", label: "可接受住得近但不同住" },
      { value: "can_live_with_parents", label: "可接受与父母同住" },
      { value: "prefer_with_parents", label: "更倾向与父母同住" }
    ]
  }
];

export const REALITY_OPTION_LABELS = Object.fromEntries(
  REALITY_FIELD_DEFS.map((field) => [
    field.key,
    Object.fromEntries(field.options.map((option) => [option.value, option.label]))
  ])
);
