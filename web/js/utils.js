function getUrlParam(parameter, defaultvalue) {
    const vars = getUrlVars(); // exact key match: "camon" inside a username must not count
    const decode = v => { try { return decodeURIComponent(v); } catch { return v; } }; // stray "%" (e.g. "100%") stays raw instead of blanking the page
    let ret = parameter in vars ? decode(vars[parameter]) : defaultvalue; // bare "#camon" -> "undefined", truthy as before
    ret = ret == "false" ? false : ret;
    return ret;
}

function getUrlVars() {
    const parseVars = (str) => {
        if (str.length <= 1) {
            return {}
        }
        const keyValuePairs = str.substring(1).split("&")
        const res = {}
        for (let i = 0; i < keyValuePairs.length; i++) {
            const keyValuePair = keyValuePairs[i];
            const [key, value] = keyValuePair.split('=')
            res[key] = value
        }
        return res
    }

    return Object.assign(
        {},
        parseVars(window.location.search),
        parseVars(window.location.hash)
    )
}
