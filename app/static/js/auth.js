(function () {
    const token = window.AppStorage.getToken();
    const path = window.location.pathname;

    if (token && (path === "/login" || path === "/register")) {
        window.location.href = "/";
        return;
    }

    const errorBox = document.getElementById("auth-error");

    function showError(message) {
        if (!errorBox) {
            return;
        }
        errorBox.textContent = message;
    }

    const loginForm = document.getElementById("login-form");
    if (loginForm) {
        loginForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            showError("");

            const formData = new FormData(loginForm);
            const payload = {
                login: formData.get("login"),
                password: formData.get("password"),
            };

            try {
                const result = await window.Api.login(payload);
                window.AppStorage.setToken(result.access_token);
                window.AppStorage.setUser(result.user);
                window.location.href = "/";
            } catch (error) {
                showError(error.message || "Ошибка входа");
            }
        });
    }

    const registerForm = document.getElementById("register-form");
    if (registerForm) {
        registerForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            showError("");

            const formData = new FormData(registerForm);
            const payload = {
                username: formData.get("username"),
                display_name: formData.get("display_name"),
                email: formData.get("email"),
                password: formData.get("password"),
            };

            try {
                const result = await window.Api.register(payload);
                window.AppStorage.setToken(result.access_token);
                window.AppStorage.setUser(result.user);
                window.location.href = "/";
            } catch (error) {
                showError(error.message || "Ошибка регистрации");
            }
        });
    }
})();
