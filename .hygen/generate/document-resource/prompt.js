module.exports = {
    prompt: ({ inquirer, args }) => {
        const questions = [];

        if (!args.name) {
            questions.push({
                type: 'input',
                name: 'name',
                message: 'Name of the resource (e.g. User)?'
            });
        }

        if (!args.pagination) {
            questions.push({
                type: 'list',
                name: 'pagination',
                message: 'What kind of pagination do you want?',
                choices: ['table', 'infinity'],
                default: 'table'
            });
        }

        return inquirer.prompt(questions).then((answers) => {
            return { ...args, ...answers };
        });
    }
};
