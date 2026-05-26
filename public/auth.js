import { fetchJson } from "./common.js";

const registerForm = document.querySelector("#register-form");
const loginForm = document.querySelector("#login-form");
const statusText = document.querySelector("#auth-status");

function setStatus(state, message) {
  statusText.dataset.state = state;
  statusText.textContent = message;
}

async function submit(endpoint, payload, successMessage) {
  setStatus("saving", "正在提交...");
  await fetchJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  setStatus("saved", successMessage);
  window.location.href = "/";
}

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(registerForm);

  try {
    await submit(
      "/api/auth/register",
      {
        email: data.get("email"),
        displayName: data.get("displayName"),
        password: data.get("password")
      },
      "注册成功，正在进入首页..."
    );
  } catch (error) {
    setStatus("error", `注册失败：${error.message}`);
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(loginForm);

  try {
    await submit(
      "/api/auth/login",
      {
        email: data.get("email"),
        password: data.get("password")
      },
      "登录成功，正在进入首页..."
    );
  } catch (error) {
    setStatus("error", `登录失败：${error.message}`);
  }
});
